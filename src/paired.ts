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
  /** Set when the pairing includes "Mint NFTs": the limits chosen on the phone. */
  mint?: MintInfo | null;
  /** 'brc100': a "main wallet" pairing (`bwalletx pair --main`) that `serve --wallet paired` forwards BRC-100 calls over. */
  mode?: 'agent' | 'brc100';
  /** The limits the phone set for a brc100 pairing (informational: the phone enforces them). */
  caps?: Brc100Caps | null;
};
export type Brc100Caps = { dailyUsd?: number; perCallUsd?: number; origins?: string[] };
export type LoginOptions = { mode?: 'agent' | 'brc100' };
export type MintInfo = { maxItems: number; maxUsd: number; itemsUsed: number; spentUsd: number; itemsLeft: number; usdLeft: number };

const file = (name: string) => join(home(), 'paired', `${name}.json`);
export const readPairing = (name: string) => readJsonFile<Pairing>(file(name));
const savePairing = (p: Pairing) => writeJsonFile(file(p.name), p, 0o600);
export const isPaired = (name: string) => existsSync(file(name));

const open = (url: string) => new WebSocket(url, { headers: { Origin: CLI_ORIGIN }, handshakeTimeout: 10_000 });

/** `bwalletx login`: show a QR, wait for the phone, save the pairing as account `name`. */
export async function login(name: string, opts: LoginOptions = {}, out: (s: string) => void = console.log): Promise<Pairing> {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || name.startsWith('.')) throw new Error(`Bad account name "${name}"`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const r = await round(name, opts.mode ?? 'agent', out);
    if (r) return r;
    out('\nThe code expired; here is a new one.\n');
  }
  throw new Error('Pairing timed out. Run `bwalletx login` again.');
}

function round(name: string, mode: 'agent' | 'brc100', out: (s: string) => void): Promise<Pairing | null> {
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
      out(
        yellow(
          mode === 'brc100'
            ? 'In bWalletX: open your MAIN account, then Settings › Paired websites › Scan to connect (choose caps, sites and expiry)'
            : 'In bWalletX: open the account to use (an AGENT account, or any account for minting only), then Settings › Paired websites › Scan to connect',
        ),
      );
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
        ws.send(JSON.stringify(await sealer.seal({ t: 'req', id: infoId, action: 'info', params: mode === 'brc100' ? { mode } : {} })));
      } else if (msg.t === 'res' && msg.id === infoId) {
        if (msg.error) return (ws.close(), reject(new Error(msg.error.message)));
        const i = msg.result as { account: string; identityAddress: string; scopes: string[]; expiresAt: number; mint?: MintInfo | null; caps?: Brc100Caps | null; mode?: string };
        if (mode === 'brc100' && i.mode !== 'brc100') return (ws.close(), reject(new Error('This bWalletX version does not support main-wallet pairing yet (no brc100 mode in its answer).')));
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
          mint: i.mint ?? null,
          mode,
          ...(mode === 'brc100' && { caps: i.caps ?? null }),
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

/**
 * The relay allows 60 frames a minute per channel (both directions) and 4 MB per frame. A request and
 * its answer are two frames, so requests are spaced at least this far apart.
 */
export const MIN_REQUEST_GAP_MS = 2_200;

/**
 * One open connection to the phone for many requests (minting a batch). The app must be open (and
 * unlocked) on the paired account. Counters are saved after every frame, so a crash can't replay.
 */
export class PhoneSession {
  private ws!: WebSocket;
  private sealer!: Sealer;
  private p!: Pairing;
  private waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private lastSend = 0;
  private closed = false;
  private constructor(private name: string) {}

  static async open(name: string): Promise<PhoneSession> {
    const s = new PhoneSession(name);
    await s.connect();
    return s;
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  get pairing() {
    return this.p;
  }

  private async connect() {
    const p = readPairing(this.name);
    if (!p) throw new Error(`"${this.name}" isn't a paired account`);
    if (Date.now() > p.expiresAt) throw new Error(`The pairing for ${this.name} expired. Run \`bwalletx login --account ${this.name}\` again.`);
    this.p = p;
    const { key } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
    this.sealer = new Sealer(key, 'site');
    this.sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
    // A fresh expiry lets the relay recreate the channel if it was dropped; the phone rejoins on its own.
    this.ws = open(relaySocketUrl(p.r, p.c, 'site', Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10));
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => reject(new Error(`Pairing service unreachable: ${e.message}`)));
    });
    this.ws.on('message', (raw) => void this.onFrame(String(raw)));
    this.ws.on('close', () => ((this.closed = true), this.failAll(new Error('Connection to the pairing service closed.'))));
  }

  private persist() {
    savePairing({ ...readPairing(this.name)!, ...this.sealer.counters });
  }

  private failAll(e: Error) {
    for (const [, w] of this.waiting) (clearTimeout(w.timer), w.reject(e));
    this.waiting.clear();
  }

  private async onFrame(raw: string) {
    const f = JSON.parse(raw) as unknown;
    if ((f as { t?: string; error?: string }).t === 'relay' && (f as { error?: string }).error)
      return this.failAll(new Error(`Pairing service: ${(f as { error: string }).error}`));
    if (!isSealed(f)) return;
    const msg = await this.sealer.open(f);
    if (!msg) return;
    this.persist();
    if (msg.t === 'res') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else w.resolve(msg.result);
    } else if (msg.t === 'close') {
      forgetPairing(this.name);
      this.failAll(new Error('Disconnected on the phone. Run `bwalletx login` to pair again.'));
    }
  }

  async call<T = unknown>(action: string, params: unknown = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) throw new Error('Session closed');
    const wait = this.lastSend + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastSend = Date.now();
    const id = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`No answer from your phone. Open bWalletX on "${this.p.account}" (unlocked) and try again.`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    this.ws.send(JSON.stringify(await this.sealer.seal({ t: 'req', id, action, params } satisfies PairMessage)));
    this.persist();
    return result;
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}

/** One request to the phone. The app must be open (and unlocked) on the paired account. */
export async function callPhone<T = unknown>(name: string, action: string, params: unknown = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const s = await PhoneSession.open(name);
  try {
    return await s.call<T>(action, params, timeoutMs);
  } finally {
    s.close();
  }
}

export { CALL_TIMEOUT_MS };

/**
 * One BRC-100 call forwarded to the paired main wallet, inside the usual {action, params} envelope.
 * The phone checks the grant, origin, method and caps, prompts as needed, and signs/broadcasts itself.
 * Pass `session` to reuse one connection (serve does: concurrent sessions would reuse counters).
 */
export async function callBrc100<T = unknown>(
  name: string,
  method: string,
  args: unknown,
  site: string,
  o: { session?: PhoneSession; timeoutMs?: number } = {},
): Promise<T> {
  const params = { method, args, site };
  if (o.session) return o.session.call<T>('brc100', params, o.timeoutMs ?? CALL_TIMEOUT_MS);
  return callPhone<T>(name, 'brc100', params, o.timeoutMs ?? CALL_TIMEOUT_MS);
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
