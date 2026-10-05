/**
 * Paired mode: the CLI pairs with bWalletX on a phone like a website does (src/pair/protocol.ts, shared
 * with the app), but as origin CLI_ORIGIN, which the app treats as "a program on a computer" and binds
 * to ONE agent account with scopes and an expiry (≤30 days). Keys never leave the phone: every call is
 * an end-to-end encrypted request through the relay, checked and signed by the app.
 *
 * Stored per pairing: ~/.bwalletx/paired/<name>.json (mode 600) — the pairing key (not a wallet key),
 * the phone's pairing public key, the channel and the message counters.
 */
import { PrivateKey } from '@bsv/sdk';
import QRCode from 'qrcode';
import { brandQr, yellow } from './brand.js';
import WebSocket from 'ws';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RELAY,
  PAIR_VERSION,
  QR_LIFETIME_S,
  Sealer,
  deriveSession,
  isSealed,
  newChannel,
  pairUrl,
  relaySocketUrl,
  type HelloFrame,
  type PairMessage,
} from './pair/protocol.js';
import { home, readConfig, readJsonFile, writeConfig, writeJsonFile } from './store.js';

export const CLI_ORIGIN = 'https://cli.bwalletx.com';
const CALL_TIMEOUT_MS = 75_000;

export type Pairing = {
  format: 'bwalletx.pairing/1';
  name: string;
  c: string;
  r: string;
  s: string; // pairing key (hex): NOT a wallet key
  k: string; // the phone's pairing public key
  sent: number;
  lastSeen: number;
  account: string;
  identityAddress: string;
  scopes: string[];
  expiresAt: number;
  pairedAt: number;
};

const file = (name: string) => join(home(), 'paired', `${name}.json`);
export const readPairing = (name: string) => readJsonFile<Pairing>(file(name));
const savePairing = (p: Pairing) => writeJsonFile(file(p.name), p, 0o600);
export const isPaired = (name: string) => existsSync(file(name));

const open = (url: string) => new WebSocket(url, { headers: { Origin: CLI_ORIGIN }, handshakeTimeout: 10_000 });

/** `bwalletx login`: show a QR, wait for the phone, save the pairing as account `name`. */
export async function login(name: string, out: (s: string) => void = console.log): Promise<Pairing> {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || name.startsWith('.')) throw new Error(`Bad account name "${name}"`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const r = await round(name, out);
    if (r) return r;
    out('\nThe code expired; here is a new one.\n');
  }
  throw new Error('Pairing timed out. Run `bwalletx login` again.');
}

function round(name: string, out: (s: string) => void): Promise<Pairing | null> {
  const S = PrivateKey.fromRandom();
  const c = newChannel();
  const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S;
  const link = pairUrl({ v: PAIR_VERSION, r: DEFAULT_RELAY, c, k: S.toPublicKey().toString(), o: CLI_ORIGIN, e });
  return new Promise((resolve, reject) => {
    const ws = open(relaySocketUrl(DEFAULT_RELAY, c, 'site', e));
    let sealer: Sealer | null = null;
    let phoneKey = '';
    let infoId = '';
    const timer = setTimeout(() => !sealer && (ws.close(), resolve(null)), QR_LIFETIME_S * 1000 - 5000);
    ws.on('open', async () => {
      out(brandQr(await QRCode.toString(link, { type: 'terminal', small: true })));
      out(yellow('In bWalletX: open your AGENT account, then Settings › Paired websites › Scan to connect'));
      out(`Or open this link on the phone:\n${link}\n`);
    });
    ws.on('error', (err) => !sealer && (clearTimeout(timer), reject(new Error(`Pairing service unreachable: ${err.message}`))));
    ws.on('message', async (raw) => {
      const f = JSON.parse(String(raw)) as unknown;
      if ((f as HelloFrame).t === 'hello' && !sealer) {
        clearTimeout(timer);
        phoneKey = (f as HelloFrame).k;
        const { key, code } = await deriveSession(S, phoneKey, c);
        sealer = new Sealer(key, 'site');
        out(`Check your phone shows the code  ${code}  then choose what the CLI may do and tap Pair.`);
        return;
      }
      if (!sealer || !isSealed(f)) return;
      const msg = await sealer.open(f);
      if (!msg) return;
      if (msg.t === 'ready') {
        infoId = `info-${Date.now()}`;
        ws.send(JSON.stringify(await sealer.seal({ t: 'req', id: infoId, action: 'info', params: {} })));
      } else if (msg.t === 'res' && msg.id === infoId) {
        if (msg.error) return (ws.close(), reject(new Error(msg.error.message)));
        const i = msg.result as { account: string; identityAddress: string; scopes: string[]; expiresAt: number };
        const p: Pairing = {
          format: 'bwalletx.pairing/1',
          name,
          c,
          r: DEFAULT_RELAY,
          s: S.toHex(),
          k: phoneKey,
          ...sealer.counters,
          account: i.account,
          identityAddress: i.identityAddress,
          scopes: i.scopes,
          expiresAt: i.expiresAt,
          pairedAt: Date.now(),
        };
        savePairing(p);
        const cfg = readConfig();
        cfg.accounts[name] = {
          name,
          kind: 'paired',
          identityAddress: i.identityAddress,
          payAddress: '',
          ordAddress: '',
          dailyCapUsd: null,
          stopped: false,
          importedAt: Date.now(),
        };
        if (!cfg.defaultAccount) cfg.defaultAccount = name;
        writeConfig(cfg);
        ws.close();
        resolve(p);
      } else if (msg.t === 'close') {
        ws.close();
        reject(new Error('Cancelled on the phone.'));
      }
    });
  });
}

/** One request to the phone. The app must be open (and unlocked) on the paired agent account. */
export async function callPhone<T = unknown>(name: string, action: string, params: unknown = {}): Promise<T> {
  const p = readPairing(name);
  if (!p) throw new Error(`"${name}" isn't a paired account`);
  if (Date.now() > p.expiresAt) throw new Error(`The pairing for ${name} expired. Run \`bwalletx login --account ${name}\` again.`);
  const { key } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
  const sealer = new Sealer(key, 'site');
  sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
  const id = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // A fresh expiry lets the relay recreate the channel if it was dropped; the phone rejoins on its own.
  const ws = open(relaySocketUrl(p.r, p.c, 'site', Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10));
  const persist = () => savePairing({ ...p, ...sealer.counters });
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No answer from your phone. Open bWalletX on "${p.account}" (unlocked) and try again.`)),
        CALL_TIMEOUT_MS,
      );
      ws.on('error', (e) => (clearTimeout(timer), reject(new Error(`Pairing service unreachable: ${e.message}`))));
      ws.on('open', async () => {
        ws.send(JSON.stringify(await sealer.seal({ t: 'req', id, action, params } satisfies PairMessage)));
        persist();
      });
      ws.on('message', async (raw) => {
        const f = JSON.parse(String(raw)) as unknown;
        if (!isSealed(f)) return;
        const msg = await sealer.open(f);
        if (!msg) return;
        persist();
        if (msg.t === 'res' && msg.id === id) {
          clearTimeout(timer);
          if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
          else resolve(msg.result as T);
        } else if (msg.t === 'close') {
          clearTimeout(timer);
          forgetPairing(name);
          reject(new Error('Disconnected on the phone. Run `bwalletx login` to pair again.'));
        }
      });
    });
  } finally {
    ws.close();
  }
}

/** Forget a pairing here (and tell the phone, best effort). */
export async function unpair(name: string) {
  const p = readPairing(name);
  if (!p) throw new Error(`"${name}" isn't a paired account`);
  try {
    const { key } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
    const sealer = new Sealer(key, 'site');
    sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
    const ws = open(relaySocketUrl(p.r, p.c, 'site', Math.floor(Date.now() / 1000) + 100));
    await new Promise<void>((res) => {
      ws.on('open', async () => (ws.send(JSON.stringify(await sealer.seal({ t: 'close', reason: 'cli logout' }))), setTimeout(res, 500)));
      ws.on('error', () => res());
      setTimeout(res, 5000);
    });
    ws.close();
  } catch {
    /* the phone forgets it when the pairing expires anyway */
  }
  forgetPairing(name);
}

function forgetPairing(name: string) {
  rmSync(file(name), { force: true });
  const cfg = readConfig();
  delete cfg.accounts[name];
  if (cfg.defaultAccount === name) delete cfg.defaultAccount;
  writeConfig(cfg);
}
