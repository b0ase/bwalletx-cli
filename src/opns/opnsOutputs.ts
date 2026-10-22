/**
 * Pure helpers over the wallet's OpNS basket (no wallet, no network): paging past the 10,000-output page,
 * reading a name/id/price off an output, finding a cancelled listing's returned output, relist planning and
 * its resumable progress file. Wired up in headless.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tierUsd, usdToSats } from './batch.js';

export type OpnsOutput = { outpoint: string; tags?: string[]; customInstructions?: string };
export type OpnsPage<T extends OpnsOutput = OpnsOutput> = { outputs: T[]; totalOutputs?: number };

export const PAGE_SIZE = 5_000;

/** Every output in the basket, page by page (one page used to cap the wallet at 10,000 names). */
export const listAllPaged = async <T extends OpnsOutput>(
  page: (offset: number, limit: number) => Promise<OpnsPage<T>>,
  pageSize = PAGE_SIZE,
): Promise<T[]> => {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const r = await page(offset, pageSize);
    all.push(...r.outputs);
    if (r.outputs.length < pageSize) break;
    if (typeof r.totalOutputs === 'number' && all.length >= r.totalOutputs) break;
  }
  return all;
};

export const isListedOutput = (o: OpnsOutput) => !!o.tags?.some((t) => t.startsWith('ordlock'));
export const idOfOutput = (o: OpnsOutput) => o.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o.outpoint;
/** On-chain listing price, from the `price:<sats>` tag sellOpns writes. */
export const priceOfOutput = (o: OpnsOutput): number | null => {
  const p = Number(o.tags?.find((t) => t.startsWith('price:'))?.slice(6));
  return Number.isFinite(p) && p > 0 ? p : null;
};
/** Listing outputs and cancelled-then-returned outputs carry no name: tag; their name is in customInstructions. */
export const nameOfOutput = (o: OpnsOutput): string => {
  const t = o.tags?.find((x) => x.startsWith('name:'))?.slice(5);
  if (t) return t.toLowerCase();
  try {
    const n = (JSON.parse(o.customInstructions ?? '') as { name?: unknown }).name;
    return typeof n === 'string' ? n.toLowerCase() : '';
  } catch {
    return '';
  }
};
export const fromTxid = (o: OpnsOutput, txid: string) => o.outpoint.startsWith(`${txid}.`) || o.outpoint.startsWith(`${txid}_`);

/** Our unlisted output for `name` (by tag or customInstructions), or undefined. */
export const unlistedIdFor = (outputs: OpnsOutput[], name: string): string | undefined => {
  const o = outputs.find((x) => !isListedOutput(x) && nameOfOutput(x) === name.toLowerCase());
  return o ? idOfOutput(o) : undefined;
};

/**
 * After a cancel the returned output takes a moment to be ingested: look for it by the cancel txid, polling
 * (every `everyMs`, up to `maxMs`). `poke` runs before each retry (send waiting txs / let the monitor work).
 */
export const findAfterCancel = async (
  list: () => Promise<OpnsOutput[]>,
  txid: string,
  o: { maxMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; poke?: () => Promise<unknown> } = {},
): Promise<OpnsOutput | undefined> => {
  const max = o.maxMs ?? 30_000;
  const every = o.everyMs ?? 2_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += every) {
    const hit = (await list()).find((x) => fromTxid(x, txid));
    if (hit) return hit;
    if (waited + every > max) return undefined;
    await sleep(every);
    await o.poke?.().catch(() => undefined);
  }
};

// ---- relist -------------------------------------------------------------------------------------------

export type RelistItem = { name: string; id: string; outpoint: string; oldSats: number; newSats: number; newUsd: number };
export type RelistPlan = { change: RelistItem[]; same: number; premium: string[]; outOfRange: number; unknownPrice: string[]; notListed: string[] };

/**
 * Which of our listings move to the current tier price. A listing priced above its tier is treated as a
 * premium/offer price and kept unless `only` (the --file names) names it. Prices within 2% of the tier
 * count as already right (the BSV rate moves).
 */
export const planRelist = (
  outputs: OpnsOutput[],
  rate: number,
  o: { only?: Set<string>; minLen?: number; maxLen?: number; tolerance?: number } = {},
): RelistPlan => {
  const tol = o.tolerance ?? 0.02;
  const plan: RelistPlan = { change: [], same: 0, premium: [], outOfRange: 0, unknownPrice: [], notListed: [] };
  const seen = new Set<string>();
  for (const x of outputs) {
    if (!isListedOutput(x)) continue;
    const name = nameOfOutput(x);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (o.only && !o.only.has(name)) continue;
    if ((o.minLen && name.length < o.minLen) || (o.maxLen && name.length > o.maxLen)) {
      plan.outOfRange++;
      continue;
    }
    const oldSats = priceOfOutput(x);
    if (oldSats == null) {
      plan.unknownPrice.push(name);
      continue;
    }
    const newUsd = tierUsd(name);
    const newSats = usdToSats(newUsd, rate);
    if (Math.abs(oldSats - newSats) <= newSats * tol) {
      plan.same++;
      continue;
    }
    if (oldSats > newSats && !o.only) {
      plan.premium.push(name);
      continue;
    }
    plan.change.push({ name, id: idOfOutput(x), outpoint: x.outpoint, oldSats, newSats, newUsd });
  }
  if (o.only) for (const n of o.only) if (!seen.has(n)) plan.notListed.push(n);
  return plan;
};

/** Counts by name length with the old→new price span, for the dry run. */
export const summariseRelist = (items: RelistItem[], rate: number) => {
  const by = new Map<number, { count: number; oldMin: number; oldMax: number; newSats: number; newUsd: number }>();
  for (const it of items) {
    const k = Math.min(it.name.length, 5);
    const b = by.get(k) ?? { count: 0, oldMin: Infinity, oldMax: 0, newSats: it.newSats, newUsd: it.newUsd };
    b.count++;
    b.oldMin = Math.min(b.oldMin, it.oldSats);
    b.oldMax = Math.max(b.oldMax, it.oldSats);
    by.set(k, b);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([len, b]) => ({
      length: len >= 5 ? '5+' : String(len),
      count: b.count,
      oldSats: b.oldMin === b.oldMax ? `${b.oldMin}` : `${b.oldMin}–${b.oldMax}`,
      oldUsd: `$${((b.oldMin / 1e8) * rate).toFixed(2)}${b.oldMin === b.oldMax ? '' : `–$${((b.oldMax / 1e8) * rate).toFixed(2)}`}`,
      newSats: b.newSats,
      newUsd: b.newUsd,
    }));
};

export type RelistProgress = { v: 1; account: string; done: Record<string, { txid?: string; at: number; sats?: number }>; pending: Record<string, { cancelTxid: string; at: number }> };

export const loadRelistProgress = (path: string, account: string): RelistProgress => {
  try {
    const p = JSON.parse(readFileSync(path, 'utf8')) as RelistProgress;
    if (p?.v === 1 && p.done) return { ...p, pending: p.pending ?? {} };
  } catch {
    /* fresh */
  }
  return { v: 1, account, done: {}, pending: {} };
};
export const saveRelistProgress = (path: string, p: RelistProgress) => writeFileSync(path, JSON.stringify(p, null, 1), { mode: 0o600 });
/** Items still to do on this run (done names are skipped; a rerun resumes). */
export const remaining = (items: RelistItem[], p: RelistProgress) => items.filter((it) => !p.done[it.name]);
