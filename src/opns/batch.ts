/**
 * Headless OpNS batch minter (owner, approved 13 Oct 2026): `bwalletx opns mint <lists…>`.
 *
 * One agent account is funded once; every name in the lists is mined unattended from that account only:
 *   - lists are parsed like bWalletX (parseNameList), merged, deduped and sorted alphabetically so a prefix is
 *     mined before the names that extend it (orderForMinting) and its characters are reused;
 *   - every name is re-checked right before it is mined (taken → skipped; ours already → kept);
 *   - names in the --vault / --gift lists are locked straight to the owner's ordinals address (--to) and never
 *     listed; every other name stays in the agent account and is listed with OrdLock v2 at its length tier;
 *   - spending stays within --budget: the run stops cleanly before a name that would go over it;
 *   - the queue is saved after every change (~/.bwalletx/opns-batch-<account>.json), so a crash or Ctrl-C
 *     resumes exactly where it stopped. Characters already mined are reused through the mine-tree cache.
 *
 * Pure logic here (testable with mocks); the wallet and network glue is in headless.ts.
 */
import { MiningCancelled, NameTakenError, type Progress } from './opnsRegister.js';
import { EXPECTED_HASHES } from './opnsPow.js';
import { isTaken, OPNS_CHARSET } from './opnsMint.js';
import type { Fetch } from './services.js';
import { WOC } from '../market.js';

// ---- lists --------------------------------------------------------------------------------------------

export type ParsedList = { names: string[]; invalid: string[] };

/** bWalletX opnsBatch.ts parseNameList: one name per line or comma/space separated; `#` comments; @/$ dropped. */
export const parseNameList = (text: string): ParsedList => {
  const names: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const tokens = text.split(/\r?\n/).flatMap((line) => line.replace(/#.*$/, '').split(/[\s,;]+/));
  for (const raw of tokens) {
    const n = raw
      .trim()
      .toLowerCase()
      .replace(/^[@$]+/, '');
    if (!n) continue;
    if (!OPNS_CHARSET.test(n)) {
      if (!invalid.includes(n)) invalid.push(n);
    } else if (!seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }
  return { names, invalid };
};

/**
 * Valuable names first (owner, 13 Oct 2026: the full job takes ~11 days, so the best names must exist on day one):
 * by `rank` (vault and gift 0, then the lists in the order given), alphabetical within a rank so every prefix
 * comes before the names that extend it (b0as < b0ase < b0asex). No rank = alphabetical only.
 */
export const orderForMinting = (names: string[], rank?: ReadonlyMap<string, number>): string[] => {
  const r = (n: string) => rank?.get(n) ?? Number.MAX_SAFE_INTEGER;
  return [...names].sort((a, b) => r(a) - r(b) || (a < b ? -1 : a > b ? 1 : 0));
};

/** Rank for orderForMinting: vault and gift names 0, then each name's first list (1, 2, …). */
export const mintRanks = (lists: string[][], vault: string[] = [], gift: string[] = []): Map<string, number> => {
  const rank = new Map<string, number>();
  for (const n of [...vault, ...gift]) rank.set(n, 0);
  lists.forEach((l, i) => l.forEach((n) => rank.has(n) || rank.set(n, i + 1)));
  return rank;
};

export type Route = 'sell' | 'vault' | 'gift';

/**
 * The whole job: names from all lists (vault and gift lists are minted too), deduped and sorted. A name in the
 * vault or gift list is routed there even when it also appears in a sale list.
 */
export const buildQueue = (lists: string[][], vault: string[] = [], gift: string[] = [], listsOnly = false): { name: string; route: Route }[] => {
  const v = new Set(vault);
  const g = new Set(gift);
  // listsOnly (a second machine): the vault/gift files only decide where a name goes; they add no names.
  const all = new Set<string>(listsOnly ? lists.flat() : [...lists.flat(), ...vault, ...gift]);
  return orderForMinting([...all], mintRanks(lists, vault, gift)).map((name) => ({ name, route: g.has(name) ? 'gift' : v.has(name) ? 'vault' : 'sell' }));
};

// ---- prices -------------------------------------------------------------------------------------------

/** Listing tier by length (owner, 13 Oct): 5+ chars $1, 4 chars $5, 3 chars or fewer $15. */
export const tierUsd = (name: string): number => (name.length >= 5 ? 1 : name.length === 4 ? 5 : 15);

/** Whole sats for `usd` at `rate` USD/BSV, rounded up so the seller never gets less than asked. */
export const usdToSats = (usd: number, rate: number): number => {
  if (!(rate > 0)) throw new Error('No BSV price');
  return Math.ceil((usd / rate) * 1e8);
};

// ---- state --------------------------------------------------------------------------------------------

export type ItemStatus = 'pending' | 'mining' | 'done' | 'skipped' | 'mine' | 'error';
export type Item = {
  name: string;
  route: Route;
  status: ItemStatus;
  txids: string[];
  /** Characters mined for this name in this job. */
  chars?: number;
  /** Sale names: true once listed, false when listing failed (retried at the end of each run). */
  listed?: boolean;
  listTxid?: string;
  priceUsd?: number;
  priceSats?: number;
  note?: string;
  doneAt?: number;
};

export type State = {
  v: 1;
  account: string;
  /** Owner's ordinals address: vault/gift names are locked to it. */
  to?: string;
  /** Where sale proceeds go (OrdLock v2 pay address). Default: the agent account. */
  payTo?: string;
  budgetSats: number;
  spentSats: number;
  createdAt: number;
  updatedAt: number;
  /** Seconds spent per mined character so far (mining + broadcast), for the ETA. */
  secsTotal: number;
  charsTotal: number;
  items: Item[];
  /** Why the last run stopped. */
  stopped?: string;
};

export const newState = (
  account: string,
  queue: { name: string; route: Route }[],
  o: { to?: string; payTo?: string; budgetSats: number },
  now = Date.now(),
): State => ({
  v: 1,
  account,
  to: o.to,
  payTo: o.payTo,
  budgetSats: o.budgetSats,
  spentSats: 0,
  createdAt: now,
  updatedAt: now,
  secsTotal: 0,
  charsTotal: 0,
  items: queue.map((q) => ({ ...q, status: 'pending' as const, txids: [] })),
});

/**
 * Resume: a saved job plus (maybe) new lists. Finished items keep their result; new names are added pending,
 * in alphabetical order; routes follow the latest --vault/--gift lists for names not yet minted.
 * A name that was mid-mine when the process died starts again (its mined characters are reused).
 */
export const mergeState = (
  saved: State,
  queue: { name: string; route: Route }[],
  o: { to?: string; payTo?: string; budgetSats?: number },
  prune = false,
): State => {
  const byName = new Map(saved.items.map((i) => [i.name, i]));
  // --prune: names still to do that are not in these lists leave this job (another machine takes them).
  if (prune) {
    const keep = new Set(queue.map((q) => q.name));
    for (const [n, i] of byName) if (!keep.has(n) && i.status !== 'done' && i.status !== 'skipped') byName.delete(n);
  }
  // The new queue's order wins (it is already ranked); names only in the saved job go after it.
  const rank = new Map(queue.map((q, i) => [q.name, i]));
  for (const q of queue) {
    const cur = byName.get(q.name);
    if (!cur) byName.set(q.name, { ...q, status: 'pending', txids: [] });
    else if (cur.status === 'pending' || cur.status === 'mining' || cur.status === 'error') byName.set(q.name, { ...cur, route: q.route });
  }
  const items = orderForMinting([...byName.keys()], rank).map((n) => {
    const i = byName.get(n)!;
    return i.status === 'mining' ? { ...i, status: 'pending' as const } : i;
  });
  return {
    ...saved,
    to: o.to ?? saved.to,
    payTo: o.payTo ?? saved.payTo,
    budgetSats: o.budgetSats ?? saved.budgetSats,
    items,
    stopped: undefined,
  };
};

export type Summary = {
  total: number;
  done: number;
  vaulted: number;
  listed: number;
  notListed: number;
  skipped: number;
  pending: number;
  spentSats: number;
  budgetSats: number;
  txs: number;
  secsPerChar: number | null;
  etaSeconds: number | null;
};

/** Counts + ETA. ETA = remaining names × average characters per name so far × observed seconds per character. */
export const summarise = (s: State, hashRate?: number): Summary => {
  const by = (f: (i: Item) => boolean) => s.items.filter(f).length;
  const pending = by((i) => i.status === 'pending' || i.status === 'mining' || i.status === 'error');
  const minedItems = s.items.filter((i) => (i.chars ?? 0) > 0);
  const charsPerName = minedItems.length ? s.charsTotal / minedItems.length : null;
  const secsPerChar = s.charsTotal > 0 ? s.secsTotal / s.charsTotal : hashRate ? EXPECTED_HASHES / hashRate : null;
  return {
    total: s.items.length,
    done: by((i) => i.status === 'done' || i.status === 'mine'),
    vaulted: by((i) => (i.status === 'done' || i.status === 'mine') && i.route !== 'sell'),
    listed: by((i) => i.listed === true),
    notListed: by((i) => i.route === 'sell' && i.listed === false),
    skipped: by((i) => i.status === 'skipped'),
    pending,
    spentSats: s.spentSats,
    budgetSats: s.budgetSats,
    txs: s.items.reduce((a, i) => a + i.txids.length + (i.listTxid ? 1 : 0), 0),
    secsPerChar,
    etaSeconds: secsPerChar !== null ? pending * (charsPerName ?? 1.5) * secsPerChar : null,
  };
};

// ---- the run ------------------------------------------------------------------------------------------

export type MineFn = (
  name: string,
  lockTo: (newDomain: string) => string | undefined,
  signal: AbortSignal,
  onProgress: (p: Progress) => void,
) => Promise<{ txid: string; newDomain: string }[]>;

export type RunDeps = {
  fetch: Fetch;
  mine: MineFn;
  /** Lists one name from the agent account for `sats` (OrdLock v2), returns the txid. */
  list: (name: string, sats: number) => Promise<string>;
  /** The name is already listed by the agent account (a refused listing may still have gone out). */
  isListed: (name: string) => Promise<boolean>;
  /** USD per BSV, live. */
  rate: () => Promise<number>;
  /** Characters still to mine for `name` (deepest node we can mine from), null when unknown. */
  charsNeeded: (name: string) => Promise<number | null>;
  /** Ours already (minted earlier, maybe unconfirmed): never mined twice. */
  isOurs: (name: string) => boolean;
  /** Spendable sats in the agent account (stop before a name it can't pay for). */
  balance?: () => Promise<number>;
  /** Kill switch (bwalletx stop / account stopped). */
  stopped?: () => boolean;
  perCharSats: number;
  listFeeSats: number;
  save: (s: State) => void;
  onUpdate: (s: State, p?: Progress & { name: string }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RunResult = { stopped: 'finished' | 'cancelled' | 'budget' | 'funds' | 'killed' | 'error'; error?: string; state: State };

/** Broadcast refusals worth one more try (bWalletX opnsSell.ts isRetryableListError). */
export const isRetryableListError = (msg: string) =>
  /REVIEW_ACTIONS|require review|missing.?inputs|orphan|double|conflict|not found|timeout|fetch/i.test(msg);
/** Network trouble while mining a name: wait and retry the name instead of stopping the night's run. */
// "must be valid transaction on chain" / "not found": a parent we just broadcast has not reached that provider yet
// (13 Oct 2026: it stopped the run on bitcoin3d although the txid was on chain minutes later).
export const isTransient = (msg: string) =>
  /fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|socket|429|50[234]|must be valid transaction|not found|unknown tx|bad gateway|unavailable|rate limit|still catching up/i.test(
    msg,
  );

/**
 * The wallet refuses a transaction whose unconfirmed ancestry is deeper than 12 ("Maximum BEEF depth exceeded.
 * Limit is 12"). Mints under one prefix chain off each other (each restates the parent), so a dozen names
 * sharing a prefix inside one block window hit it (14 Oct 2026: it stopped the run on "ghana" after ten in a
 * row). Nothing is wrong: the next block resets the depth. So wait for a block, then try the name again.
 */
export const isDepthLimit = (msg: string) => /Maximum BEEF depth/i.test(msg);
const BLOCK_POLL_MS = 30_000;
const BLOCK_WAIT_MAX_MS = 30 * 60_000;
const DEPTH_WAITS = 3;

/** Resolves when WhatsOnChain reports a new block (or after BLOCK_WAIT_MAX_MS / abort). */
export const waitForNextBlock = async (
  f: Fetch,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal,
  maxMs = BLOCK_WAIT_MAX_MS,
  pollMs = BLOCK_POLL_MS,
): Promise<boolean> => {
  const height = async () => {
    const r = await f(`${WOC}/chain/info`).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { blocks?: number } | null) : null;
    return typeof j?.blocks === 'number' ? j.blocks : null;
  };
  const start = await height();
  for (let waited = 0; waited < maxMs && !signal.aborted; waited += pollMs) {
    await sleep(pollMs);
    const h = await height();
    if (start === null || (h !== null && h > start)) return true;
  }
  return false;
};

const LIST_RETRIES = 2;
const LIST_RETRY_MS = 5000;
const NAME_RETRIES = 4;
const NAME_RETRY_MS = 30_000;

export const BUDGET_STOP = 'Stopped before going over the budget';

export const runHeadless = async (deps: RunDeps, start: State, signal: AbortSignal): Promise<RunResult> => {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let state: State = { ...start, stopped: undefined };
  let failedInARow = 0;
  const commit = (patch: Partial<State>) => {
    state = { ...state, ...patch, updatedAt: now() };
    deps.save(state);
    deps.onUpdate(state);
  };
  const set = (i: number, patch: Partial<Item>, extra: Partial<State> = {}) =>
    commit({ ...extra, items: state.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const end = (stopped: RunResult['stopped'], error?: string): RunResult => {
    commit({ stopped: error ?? stopped });
    return { stopped, error, state };
  };
  const budgetLeft = () => state.budgetSats - state.spentSats;

  /** List one sale name with retries; never stops the run (bWalletX: "Minted · not listed"). */
  const listOne = async (i: number) => {
    const it = state.items[i];
    if (it.route !== 'sell' || it.listed === true) return;
    if (deps.listFeeSats > budgetLeft()) return set(i, { listed: false, note: `Not listed: ${BUDGET_STOP.toLowerCase()}` });
    let lastErr = '';
    for (let attempt = 0; attempt <= LIST_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(LIST_RETRY_MS * attempt);
        if (signal.aborted) return;
        if (await deps.isListed(it.name).catch(() => false)) return set(i, { listed: true, note: 'Already listed' });
      }
      try {
        const usd = tierUsd(it.name);
        const sats = usdToSats(usd, await deps.rate());
        const txid = await deps.list(it.name, sats);
        return set(i, { listed: true, listTxid: txid, priceUsd: usd, priceSats: sats, note: undefined }, { spentSats: state.spentSats + deps.listFeeSats });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!isRetryableListError(lastErr)) break;
      }
    }
    set(i, { listed: false, note: `Not listed: ${lastErr}` });
  };

  deps.onUpdate(state);
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.status === 'mine' || it.status === 'done') {
      // A crash between mint and listing: list it now.
      if (it.route === 'sell' && it.listed === undefined && !signal.aborted) await listOne(i);
      continue;
    }
    if (it.status === 'skipped') continue;
    if (signal.aborted) return end('cancelled');
    if (deps.stopped?.()) return end('killed', 'Kill switch is on (bwalletx resume to continue)');
    let attempt = 0;
    let depthWaits = 0;
    for (;;) {
      try {
        if (deps.isOurs(it.name)) {
          set(i, { status: 'mine', note: 'Already minted by this account' });
          await listOne(i);
          break;
        }
        if (await isTaken(deps.fetch, it.name)) {
          set(i, { status: 'skipped', note: 'Taken by someone else' });
          break;
        }
        const chars = (await deps.charsNeeded(it.name)) ?? it.name.length;
        const need = chars * deps.perCharSats + (it.route === 'sell' ? deps.listFeeSats : 0);
        if (need > budgetLeft()) {
          set(i, { status: 'pending', note: 'Over the budget' });
          return end('budget', `${BUDGET_STOP}: "${it.name}" needs ~${need} sats, ${Math.max(0, budgetLeft())} left`);
        }
        if (deps.balance) {
          const have = await deps.balance();
          if (have < need) {
            set(i, { status: 'pending', note: 'Account balance too low' });
            return end('funds', `The agent account holds ${have} sats; "${it.name}" needs ~${need}. Add BSV and run again.`);
          }
        }
        set(i, { status: 'mining', note: undefined });
        const t0 = now();
        const lockTo = (d: string) => (d === it.name && it.route !== 'sell' ? state.to : undefined);
        const steps = await deps.mine(it.name, lockTo, signal, (p) => deps.onUpdate(state, { ...p, name: it.name }));
        const secs = (now() - t0) / 1000;
        set(
          i,
          { status: 'done', txids: [...it.txids, ...steps.map((s) => s.txid)], chars: steps.length, doneAt: now() },
          {
            spentSats: state.spentSats + steps.length * deps.perCharSats,
            secsTotal: state.secsTotal + (steps.length ? secs : 0),
            charsTotal: state.charsTotal + steps.length,
          },
        );
        if (steps.length) await listOne(i);
        failedInARow = 0;
        break;
      } catch (e) {
        if (e instanceof MiningCancelled || signal.aborted) {
          set(i, { status: 'pending' });
          return end('cancelled');
        }
        if (e instanceof NameTakenError) {
          set(i, { status: 'skipped', note: 'Taken by someone else' });
          break;
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (isDepthLimit(msg) && depthWaits++ < DEPTH_WAITS) {
          set(i, { status: 'pending', note: `Waiting for the next block: ${msg}` });
          await waitForNextBlock(deps.fetch, sleep, signal);
          if (signal.aborted) return end('cancelled');
          continue;
        }
        // "Still catching up" is usually the overlay lagging behind our own mints: two quick retries, then move on
        // (the next run retries it); the slow 30/60/90/120 s ladder is for real network trouble.
        const catching = /still catching up/i.test(msg);
        if (isTransient(msg) && attempt++ < (catching ? 2 : NAME_RETRIES)) {
          set(i, { status: 'pending', note: `Retrying after: ${msg}` });
          await sleep(catching ? 10_000 * attempt : NAME_RETRY_MS * attempt);
          if (signal.aborted) return end('cancelled');
          continue;
        }
        // Anything else (covenant check failed locally, wallet refused, …): note it and move on to the next name;
        // the next run retries it. Ten failures in a row means something systemic: stop then (14 Oct 2026: a
        // "still catching up" on one name used to end the whole night's run).
        set(i, { status: 'error', note: msg });
        if (++failedInARow >= 10) return end('error', `${it.name}: ${msg} (10 names in a row failed)`);
        break;
      }
    }
  }
  // Sale names whose listing failed earlier: one more try each.
  for (let i = 0; i < state.items.length && !signal.aborted; i++)
    if (state.items[i].route === 'sell' && state.items[i].listed === false) await listOne(i);
  return end(signal.aborted ? 'cancelled' : 'finished');
};

// ---- output -------------------------------------------------------------------------------------------

export const fmtDuration = (s: number | null) => {
  if (s === null || !Number.isFinite(s)) return 'estimating…';
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
};

export const progressLine = (s: State, p?: Progress & { name: string }) => {
  const m = summarise(s);
  const head = `${m.done + m.skipped}/${m.total} names · ${m.listed} listed · ${m.vaulted} to owner · ${m.skipped} taken · ${m.spentSats.toLocaleString()}/${m.budgetSats.toLocaleString()} sats · ETA ${fmtDuration(m.etaSeconds)}`;
  if (!p) return head;
  const what =
    p.phase === 'mining'
      ? `mining ${p.name} [${p.domain}+${p.name[p.domain.length] ?? ''}] char ${p.charIndex + 1}/${p.charsTotal} ${(p.rate / 1e6).toFixed(1)} MH/s`
      : `${p.phase} ${p.name}`;
  return `${head} · ${what}`;
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained progress page (refreshes itself every 30 s while open). */
export const reportHtml = (s: State) => {
  const m = summarise(s);
  const rows = s.items
    .filter((i) => i.status !== 'pending')
    .slice(-2000)
    .reverse()
    .map(
      (i) =>
        `<tr><td>${esc(i.name)}</td><td>${esc(i.route)}</td><td>${esc(i.status)}${i.listed ? ' · listed' : i.listed === false ? ' · not listed' : ''}</td><td>${i.priceUsd ? `$${i.priceUsd}` : ''}</td><td class="tx">${[...i.txids, i.listTxid]
          .filter(Boolean)
          .map((t) => `<a href="https://whatsonchain.com/tx/${esc(t)}">${esc(String(t).slice(0, 8))}</a>`)
          .join(' ')}</td><td>${esc(i.note)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>OpNS batch: ${esc(s.account)}</title>
<style>:root{color-scheme:light dark;--bg:#0b0b0c;--fg:#eee;--mut:#999;--gold:#d4af37}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{font-size:20px;color:var(--gold)}.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0}.k div{border:1px solid #333;border-radius:8px;padding:8px}.k b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;font-size:13px}td{border-top:1px solid #222;padding:4px 6px;vertical-align:top}.tx a{color:var(--gold);margin-right:4px}small{color:var(--mut)}</style></head><body>
<h1>OpNS batch · ${esc(s.account)}</h1><small>Updated ${new Date(s.updatedAt).toLocaleString()}${s.stopped ? ` · last stop: ${esc(s.stopped)}` : ''}</small>
<div class="k"><div><b>${m.done}/${m.total}</b>names done</div><div><b>${m.listed}</b>listed</div><div><b>${m.vaulted}</b>to owner</div><div><b>${m.skipped}</b>taken, skipped</div><div><b>${m.spentSats.toLocaleString()}</b>of ${m.budgetSats.toLocaleString()} sats</div><div><b>${esc(fmtDuration(m.etaSeconds))}</b>ETA</div></div>
<table><tr><td>name</td><td>route</td><td>status</td><td>price</td><td>txids</td><td>note</td></tr>${rows}</table></body></html>`;
};
