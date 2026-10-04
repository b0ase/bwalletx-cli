/**
 * Local state under ~/.bwalletx (override with BWALLETX_HOME):
 *   config.json                    accounts (public addresses, daily caps) + defaults
 *   accounts/<name>.key.json       imported encrypted key files (mode 600)
 *   strategies/<name>.json         loaded strategy per account
 *   paper/<name>.json              paper book per account
 *   log/<name>.jsonl               activity log, one JSON entry per line (oldest first)
 *   STOP                           kill switch: while it exists every spending action is refused
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentLogEntry, Loaded, PaperBook } from './strategy.js';
import { PAPER_START_USD } from './strategy.js';

export type AccountConfig = {
  name: string;
  identityAddress: string;
  payAddress: string;
  ordAddress: string;
  /** Per-account daily cap in USD; null = none (the balance is the limit). */
  dailyCapUsd: number | null;
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
