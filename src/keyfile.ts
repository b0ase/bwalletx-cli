/**
 * Agent key file (`bwalletx.agentkey/1`): how the app exports one agent account for the CLI.
 *
 *   {"format":"bwalletx.agentkey/1","name":"trader","identityAddress":"1…",
 *    "enc":{"kdf":"pbkdf2-sha256","iter":310000,"salt":b64,"iv":b64,"alg":"aes-256-gcm","data":b64}}
 *
 * `data` decrypts to JSON {"payPk":WIF,"ordPk":WIF,"identityPk":WIF}. Encryption is plain WebCrypto:
 * PBKDF2-SHA256(passphrase UTF-8, salt 16 bytes, iter) → AES-256-GCM key; iv 12 bytes; `data` is the
 * ciphertext with the 16-byte GCM tag appended (exactly what SubtleCrypto.encrypt returns). Uses only
 * globalThis.crypto.subtle, so the app can import this file unchanged.
 */
export const KEYFILE_FORMAT = 'bwalletx.agentkey/1';
export const KEYFILE_ITER = 310_000;

export type AgentKeys = { payPk: string; ordPk: string; identityPk: string };
export type AgentKeyFile = {
  format: typeof KEYFILE_FORMAT;
  name: string;
  identityAddress: string;
  enc: { kdf: 'pbkdf2-sha256'; iter: number; salt: string; iv: string; alg: 'aes-256-gcm'; data: string };
};

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available (Node 20+ required)');
  return s;
};
const b64 = (u: Uint8Array) => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const deriveKey = async (passphrase: string, salt: Uint8Array, iter: number) => {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const isWifish = (v: unknown) => typeof v === 'string' && /^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(v);

export const encryptKeyFile = async (
  name: string,
  identityAddress: string,
  keys: AgentKeys,
  passphrase: string,
  iter = KEYFILE_ITER,
): Promise<AgentKeyFile> => {
  if (!passphrase) throw new Error('A passphrase is required');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iter);
  const plain = new TextEncoder().encode(JSON.stringify({ payPk: keys.payPk, ordPk: keys.ordPk, identityPk: keys.identityPk }));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource));
  return {
    format: KEYFILE_FORMAT,
    name,
    identityAddress,
    enc: { kdf: 'pbkdf2-sha256', iter, salt: b64(salt), iv: b64(iv), alg: 'aes-256-gcm', data: b64(data) },
  };
};

/** Check a parsed key file's shape (no decryption). Throws with a readable message. */
export const validateKeyFile = (o: unknown): AgentKeyFile => {
  const f = o as AgentKeyFile;
  if (!f || typeof f !== 'object' || f.format !== KEYFILE_FORMAT) throw new Error(`Not a ${KEYFILE_FORMAT} key file`);
  if (typeof f.name !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(f.name)) throw new Error('Key file name must be 1-40 letters, digits, . _ or -');
  if (typeof f.identityAddress !== 'string' || !f.identityAddress) throw new Error('Key file has no identityAddress');
  const e = f.enc;
  if (!e || e.kdf !== 'pbkdf2-sha256' || e.alg !== 'aes-256-gcm') throw new Error('Unsupported key file encryption');
  if (!Number.isInteger(e.iter) || e.iter < 100_000 || e.iter > 10_000_000) throw new Error('Key file iteration count is out of range');
  for (const k of ['salt', 'iv', 'data'] as const) if (typeof e[k] !== 'string' || !e[k]) throw new Error(`Key file enc.${k} is missing`);
  return f;
};

export const decryptKeyFile = async (file: AgentKeyFile, passphrase: string): Promise<AgentKeys> => {
  const f = validateKeyFile(file);
  const key = await deriveKey(passphrase, unb64(f.enc.salt), f.enc.iter);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(f.enc.iv) as BufferSource }, key, unb64(f.enc.data) as BufferSource);
  } catch {
    throw new Error('Wrong passphrase or damaged key file');
  }
  const o = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
  if (!isWifish(o.payPk) || !isWifish(o.ordPk) || !isWifish(o.identityPk)) throw new Error('Key file contents are not three WIF keys');
  return { payPk: o.payPk as string, ordPk: o.ordPk as string, identityPk: o.identityPk as string };
};
