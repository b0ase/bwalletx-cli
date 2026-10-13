// Copied from bWalletX src/mobile/names/opnsPow.ts (13 Oct 2026, bWalletX commit 4e7f6e2c). Keep behaviour identical;
// fix bugs in both places. Only import paths / platform glue differ.
/**
 * OpNS proof-of-work, dependency-free so it runs in a Web Worker.
 *
 * Spec (BitcoinSchema/1sat-ordinals name-service/opns.md, @1sat/templates OpNS.testSolution):
 *   hash = sha256(sha256(pow ‖ char ‖ nonce))   pow = node seed (32 B), char = 1 B, nonce = 32 B
 *   valid when the top OPNS_DIFFICULTY (22) bits of the byte-reversed hash are zero,
 *   i.e. hash[31] == 0, hash[30] == 0 and the top 6 bits of hash[29] are zero.
 *
 * The 65-byte message spans two SHA-256 blocks. We vary nonce bytes 27..30 (block 1,
 * word 15) as an outer counter and nonce byte 31 (the only message byte in block 2) as
 * the inner loop, so block 1 is compressed once per 256 attempts.
 */
export const OPNS_DIFFICULTY = 22;
/** Expected attempts per character: 2^difficulty. */
export const EXPECTED_HASHES = 2 ** OPNS_DIFFICULTY;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** One SHA-256 compression of `w[0..15]` (big-endian words) into `st` (in place). `w` is clobbered. */
const compress = (st: Uint32Array, w: Uint32Array) => {
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15];
    const b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = st[0],
    b = st[1],
    c = st[2],
    d = st[3],
    e = st[4],
    f = st[5],
    g = st[6],
    h = st[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  st[0] = (st[0] + a) | 0;
  st[1] = (st[1] + b) | 0;
  st[2] = (st[2] + c) | 0;
  st[3] = (st[3] + d) | 0;
  st[4] = (st[4] + e) | 0;
  st[5] = (st[5] + f) | 0;
  st[6] = (st[6] + g) | 0;
  st[7] = (st[7] + h) | 0;
};

/** Mask over the last state word (bytes 28..31 big-endian) that must be zero. Bits beyond 32 are checked by meetsDifficulty. */
export const lastWordMask = (difficulty = OPNS_DIFFICULTY): number => {
  let mask = 0;
  for (let bit = 0; bit < Math.min(difficulty, 32); bit++) {
    const byteFromEnd = Math.floor(bit / 8); // 0 → hash[31]
    const bitInByte = 7 - (bit % 8); // MSB first within each reversed byte
    mask |= 1 << (byteFromEnd * 8 + bitInByte);
  }
  return mask >>> 0;
};

const toBytes = (st: Uint32Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 8; i++)
    out.push((st[i] >>> 24) & 0xff, (st[i] >>> 16) & 0xff, (st[i] >>> 8) & 0xff, st[i] & 0xff);
  return out;
};

/** Plain sha256d of the 65-byte OpNS preimage (used for verification and tests). */
export const opnsHash = (pow: number[], char: number, nonce: number[]): number[] => {
  const msg = [...pow, char, ...nonce];
  if (msg.length !== 65) throw new Error('pow and nonce must be 32 bytes each');
  const st = Uint32Array.from(IV);
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++)
    w[i] = (msg[i * 4] << 24) | (msg[i * 4 + 1] << 16) | (msg[i * 4 + 2] << 8) | msg[i * 4 + 3];
  compress(st, w);
  w.fill(0);
  w[0] = (msg[64] << 24) | 0x800000;
  w[15] = 65 * 8;
  compress(st, w);
  const st2 = Uint32Array.from(IV);
  w.fill(0);
  for (let i = 0; i < 8; i++) w[i] = st[i];
  w[8] = 0x80000000;
  w[15] = 256;
  compress(st2, w);
  return toBytes(st2);
};

export const meetsDifficulty = (hash: number[], difficulty = OPNS_DIFFICULTY): boolean => {
  const full = Math.floor(difficulty / 8);
  for (let i = 0; i < full; i++) if (hash[31 - i] !== 0) return false;
  const rem = difficulty % 8;
  return rem === 0 || (hash[31 - full] & ((0xff << (8 - rem)) & 0xff)) === 0;
};

export type MineResult = { nonce: number[]; hash: number[] } | { tried: number };

/**
 * Try `count` nonces (rounded up to multiples of 256) starting at outer counter `start`.
 * `prefix` = the first 27 nonce bytes (random per job so parallel/restarted jobs don't overlap).
 */
export const mineRange = (
  pow: number[],
  char: number,
  prefix: number[],
  start: number,
  count: number,
  difficulty = OPNS_DIFFICULTY,
): MineResult => {
  if (pow.length !== 32 || prefix.length !== 27) throw new Error('bad pow/prefix length');
  const head = [...pow, char, ...prefix]; // 60 bytes = words 0..14 of block 1
  const base = new Uint32Array(15);
  for (let i = 0; i < 15; i++)
    base[i] = (head[i * 4] << 24) | (head[i * 4 + 1] << 16) | (head[i * 4 + 2] << 8) | head[i * 4 + 3];
  const mask = lastWordMask(difficulty);
  const w = new Uint32Array(64);
  const mid = new Uint32Array(8);
  const st = new Uint32Array(8);
  const st2 = new Uint32Array(8);
  const outers = Math.ceil(count / 256);
  for (let o = 0; o < outers; o++) {
    const ctr = (start + o) >>> 0;
    mid.set(IV);
    w.set(base);
    w[15] = ctr;
    compress(mid, w);
    for (let last = 0; last < 256; last++) {
      st.set(mid);
      w.fill(0);
      w[0] = (last << 24) | 0x800000;
      w[15] = 520;
      compress(st, w);
      st2.set(IV);
      w.fill(0);
      for (let i = 0; i < 8; i++) w[i] = st[i];
      w[8] = 0x80000000;
      w[15] = 256;
      compress(st2, w);
      if ((st2[7] & mask) === 0 && (difficulty <= 32 || meetsDifficulty(toBytes(st2), difficulty))) {
        const nonce = [...prefix, (ctr >>> 24) & 0xff, (ctr >>> 16) & 0xff, (ctr >>> 8) & 0xff, ctr & 0xff, last];
        return { nonce, hash: toBytes(st2) };
      }
    }
  }
  return { tried: outers * 256 };
};

/** Seconds for `chars` characters at `hashRate` hashes/s (expected value; real time varies a lot). */
export const estimateSeconds = (chars: number, hashRate: number) =>
  hashRate > 0 ? Math.round((chars * EXPECTED_HASHES) / hashRate) : Infinity;
