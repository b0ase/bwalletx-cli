import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES, type Fetch } from './services.js';

/**
 * Is a taken-looking OpNS name ours? (15 Oct 2026)
 *
 * The local tree cache only knows names THIS machine minted, so names minted by another machine/account, or by
 * bWalletX's name minter, looked "Taken by someone else". Addresses can't answer it: BRC-100 wallets (bWalletX)
 * lock every name to a fresh derived address. So "ours" comes from records we control:
 *   (a) the ledger: ~/.bwalletx/opns-ours.txt (one name per line, # comments; append-only, sync it between
 *       machines, paste bWalletX's name export into it) plus every opns-batch-*.json / opns-tree-*.json here;
 *   (b) the agent's own BRC-100 wallet (OpNS basket).
 * Anything else stays "taken (unverified owner)", except a name whose origin predates 2024: a pre-existing
 * holder, "Taken by someone else".
 */

export type OwnerVerdict = 'ours' | 'theirs' | 'unverified';

export const OURS_FILE = 'opns-ours.txt';
/** Block ~824,000 ≈ 1 Jan 2024. Names inscribed before it were not minted by any of our tools. */
export const PRE_2024_HEIGHT = 824_000;
const GP_TXOS = 'https://ordinals.gorillapool.io/api/txos';

const norm = (n: string) => n.trim().toLowerCase();

/** Parse the ledger text: names, one per line; blank lines and # comments ignored. */
export const parseLedger = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => norm(l.replace(/#.*/, '')))
    .filter((l) => /^[a-z0-9-]+$/.test(l));

const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Every name our records say we minted: the ledger + every batch state (done/mine) + every tree cache in `dir`. */
export const ledgerNames = (dir: string): Set<string> => {
  const out = new Set<string>();
  try {
    parseLedger(readFileSync(join(dir, OURS_FILE), 'utf8')).forEach((n) => out.add(n));
  } catch {
    /* no ledger yet */
  }
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (/^opns-batch-.*\.json$/.test(f)) {
      const s = readJson(join(dir, f)) as { items?: { name?: string; status?: string; txids?: unknown[] }[] } | null;
      for (const it of s?.items ?? [])
        if (it.name && (it.status === 'done' || (it.status === 'mine' && Array.isArray(it.txids) && it.txids.length))) out.add(norm(it.name));
    } else if (/^opns-tree-.*\.json$/.test(f)) {
      const s = readJson(join(dir, f)) as { names?: Record<string, unknown> } | null;
      Object.keys(s?.names ?? {}).forEach((n) => out.add(norm(n)));
    }
  }
  return out;
};

/** Append minted names to the ledger (append-only; duplicates are harmless). */
export const appendLedger = (dir: string, names: string[], note = '') => {
  if (!names.length) return;
  const stamp = new Date().toISOString();
  appendFileSync(join(dir, OURS_FILE), names.map((n) => `${norm(n)}  # ${stamp}${note ? ` ${note}` : ''}\n`).join(''), { mode: 0o600 });
};

/** Block height the name's origin was inscribed at; null when unknown. */
export const originHeight = async (f: Fetch, name: string): Promise<number | null> => {
  const r = await f(`${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`).catch(() => null);
  const o = r?.ok ? ((await r.json().catch(() => null)) as { outpoint?: string } | null) : null;
  if (!o?.outpoint) return null;
  const g = await f(`${GP_TXOS}/${o.outpoint.replace('.', '_')}?script=false`).catch(() => null);
  const j = g?.ok ? ((await g.json().catch(() => null)) as { height?: number } | null) : null;
  return typeof j?.height === 'number' && j.height > 0 ? j.height : null;
};

export type OwnerDeps = {
  fetch: Fetch;
  /** Names our records say we minted (re-read on each call so another machine's sync is picked up). */
  ledger: () => Set<string>;
  /** Our BRC-100 wallet holds this name (OpNS basket). Optional. */
  inWallet?: (name: string) => Promise<boolean>;
};

/** Per-run, cached verdict for a name that looks taken. */
export const ownerCheck = (d: OwnerDeps) => {
  const cache = new Map<string, Promise<OwnerVerdict>>();
  const decide = async (name: string): Promise<OwnerVerdict> => {
    if (d.ledger().has(name)) return 'ours';
    if (d.inWallet && (await d.inWallet(name).catch(() => false))) return 'ours';
    const h = await originHeight(d.fetch, name).catch(() => null);
    return h !== null && h < PRE_2024_HEIGHT ? 'theirs' : 'unverified';
  };
  return async (raw: string): Promise<OwnerVerdict> => {
    const name = norm(raw);
    if (d.ledger().has(name)) return 'ours'; // never cached: a synced ledger counts mid-run
    let p = cache.get(name);
    if (!p) {
      p = decide(name);
      cache.set(name, p);
    }
    return p;
  };
};
