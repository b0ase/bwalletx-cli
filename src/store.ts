/**
 * Local state under ~/.bwalletx (override with BWALLETX_HOME):
 *   config.json                    accounts (public addresses, daily caps) + defaults
 *   accounts/<name>.key.json       imported encrypted key files (mode 600)
 *   strategies/<name>.json         loaded strategy per account
 *   paper/<name>.json              paper book per account
 *   log/<name>.jsonl               activity log, one JSON entry per line (oldest first)
 *   STOP                           kill switch: while it exists every spending action is refused
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentLogEntry, Loaded, PaperBook } from './strategy.js';
import { PAPER_START_USD } from './strategy.js';

export type AccountConfig = {
  name: string;
  /** 'key' = imported key file (standalone); 'paired' = keys stay on the phone (bwalletx login). */
  kind?: 'key' | 'paired';
  identityAddress: string;
  payAddress: string;
  ordAddress: string;
  /** Per-account daily cap in USD; null = none (the balance is the limit). */
  dailyCapUsd: number | null;
  /**
   * Spends above this many USD are refused with rule "approval": the owner approves them in bAgents.
   * null/absent = no threshold (only the daily cap applies).
   */
  approveAboveUsd?: number | null;
  /** The account's BRC-100 identity public key (compressed hex), derived at import. Public, safe to print. */
  identityKey?: string;
  /** The pay key's public key (compressed hex), derived at import. Public; lets a site record the receive address as proven. */
  payPubkey?: string;
  stopped: boolean;
  importedAt: number;
};
export type Config = { defaultAccount?: string; accounts: Record<string, AccountConfig>; satsPerKb?: number };

export const home = () => process.env.BWALLETX_HOME || join(homedir(), '.bwalletx');
const p = (...parts: string[]) => join(home(), ...parts);
const ensure = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });
const safe = (name: string) => {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || name.startsWith('.')) throw new Error(`Bad account name "${name}"`);
  return name;
};

export const readJsonFile = <T>(file: string): T | null => readJson<T>(file);
export const writeJsonFile = (file: string, v: unknown, mode = 0o600) => writeJson(file, v, mode);
const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};
const writeJson = (file: string, v: unknown, mode = 0o600) => {
  ensure(join(file, '..'));
  writeFileSync(file, JSON.stringify(v, null, 2) + '\n', { mode });
  chmodSync(file, mode);
};

export const readConfig = (): Config => readJson<Config>(p('config.json')) ?? { accounts: {} };
export const writeConfig = (c: Config) => writeJson(p('config.json'), c);

export const keyFilePath = (name: string) => p('accounts', `${safe(name)}.key.json`);
export const saveKeyFile = (name: string, file: unknown) => writeJson(keyFilePath(name), file, 0o600);
export const readKeyFile = (name: string) => readJson<unknown>(keyFilePath(name));

/** Pick the account: explicit name, else the default, else the only one. */
export const resolveAccount = (name?: string): AccountConfig => {
  const c = readConfig();
  const names = Object.keys(c.accounts);
  const n = name ?? c.defaultAccount ?? (names.length === 1 ? names[0] : undefined);
  if (!n) throw new Error(names.length ? `Several accounts; pass --account (${names.join(', ')})` : 'No accounts yet. Run `bwalletx key import <file>`.');
  const a = c.accounts[n];
  if (!a) throw new Error(`No account "${n}". Known: ${names.join(', ') || 'none'}`);
  return a;
};

export const updateAccount = (name: string, patch: Partial<AccountConfig>) => {
  const c = readConfig();
  if (!c.accounts[name]) throw new Error(`No account "${name}"`);
  c.accounts[name] = { ...c.accounts[name], ...patch };
  writeConfig(c);
};

// ---- log ----
const logFile = (name: string) => p('log', `${safe(name)}.jsonl`);
export const appendLog = (name: string, e: AgentLogEntry) => {
  ensure(p('log'));
  appendFileSync(logFile(name), JSON.stringify(e) + '\n', { mode: 0o600 });
};
/** Entries oldest first. */
export const readLog = (name: string): AgentLogEntry[] => {
  if (!existsSync(logFile(name))) return [];
  return readFileSync(logFile(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AgentLogEntry];
      } catch {
        return [];
      }
    });
};

// ---- strategy + paper ----
export const getLoaded = (name: string) => readJson<Loaded>(p('strategies', `${safe(name)}.json`));
export const setLoaded = (name: string, l: Loaded | null) => {
  const f = p('strategies', `${safe(name)}.json`);
  if (l) writeJson(f, l);
  else rmSync(f, { force: true });
};
export const getPaper = (name: string): PaperBook =>
  readJson<PaperBook>(p('paper', `${safe(name)}.json`)) ?? { cashUsd: PAPER_START_USD, tokens: {}, spentUsd: 0 };
export const setPaper = (name: string, b: PaperBook | null) => {
  const f = p('paper', `${safe(name)}.json`);
  if (b) writeJson(f, b);
  else rmSync(f, { force: true });
};

// ---- kill switch ----
const stopFile = () => p('STOP');
export const allStopped = () => existsSync(stopFile());
export const setAllStopped = (on: boolean) => {
  if (on) {
    ensure(home());
    writeFileSync(stopFile(), `stopped at ${new Date().toISOString()}\n`, { mode: 0o600 });
  } else rmSync(stopFile(), { force: true });
};

// ---- spend lock ----
/**
 * One spend at a time per account, across processes (CLI, `agent run`, MCP, `serve`). The gate reads the
 * log and the spend is logged only after it is signed, so without this two processes (or two parallel
 * `serve` requests) both pass the daily cap before either is logged (18 Oct 2026 review).
 * mkdir is atomic; a lock older than staleMs (a crashed process) is taken over.
 */
const held = new Map<string, Promise<unknown>>();
export async function withSpendLock<T>(name: string, fn: () => Promise<T>, o: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  const staleMs = o.staleMs ?? 10 * 60_000;
  const deadline = Date.now() + (o.waitMs ?? 3 * 60_000);
  // In-process: chain behind any spend already running here (serve's parallel requests).
  const prev = held.get(name) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  held.set(name, chained);
  await prev.catch(() => undefined);
  const dir = p('locks', `${safe(name)}.spend`);
  ensure(p('locks'));
  try {
    for (;;) {
      try {
        mkdirSync(dir, { mode: 0o700 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let age = 0;
        try {
          age = Date.now() - statSync(dir).mtimeMs;
        } catch {
          continue;
        }
        if (age > staleMs) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`Another spend on ${name} is still running (lock ${dir}); try again`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    release();
    if (held.get(name) === chained) held.delete(name);
  }
}
