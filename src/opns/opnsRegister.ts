// Copied from bWalletX src/mobile/names/opnsRegister.ts (13 Oct 2026, bWalletX commit 4e7f6e2c). Keep behaviour identical;
// fix bugs in both places. Only import paths / platform glue differ.
import type { OneSatContext } from '@1sat/actions';
import { OpNS } from '@1sat/templates';
import { Transaction } from '@bsv/sdk';
import type { Fetch } from './services.js';
import { EXPECTED_HASHES } from './opnsPow.js';
import {
  fetchMineNode,
  isCharClaimed,
  isTaken,
  loadNode,
  mintStep,
  OPNS_CHARSET,
  randomPrefix,
  type LoadedNode,
  type MineNode,
  type MintStepResult,
} from './opnsMint.js';
import type { OpnsTree } from './opnsTree.js';

/**
 * Register a brand-new OpNS name: mine it character by character on-device, one mint
 * transaction per missing character, chaining each step from the child node we just made.
 *
 * Races: anyone may spend the same tree node. Before every broadcast we re-read the
 * tree; if the name became taken we stop (NameTakenError); if our node was spent by
 * someone else we re-mine the character from the new node.
 */

export class NameTakenError extends Error {
  constructor(name: string) {
    super(`"${name}" was just taken by someone else`);
  }
}
export class MiningCancelled extends Error {
  constructor() {
    super('Mining cancelled');
  }
}

export type Progress = {
  phase: 'mining' | 'broadcasting' | 'done';
  /** The prefix mined so far and the character being mined now. */
  domain: string;
  charIndex: number; // 0-based among the characters still to mine
  charsTotal: number;
  tried: number; // attempts on the current character
  rate: number; // hashes/s
  /** Expected seconds left (current char remainder + remaining chars). */
  etaSeconds: number;
};

export type MineChar = (
  pow: number[],
  char: number,
  signal: AbortSignal,
  onProgress: (tried: number, rate: number) => void,
) => Promise<{ nonce: number[]; hash: number[] }>;

/** Default miner (CLI): worker_threads across the CPU cores, see miner.ts. */
const defaultMineChar: MineChar = (pow, char, signal, onProgress) =>
  import('./miner.js').then((m) => m.threadMineChar(pow, char, signal, onProgress));

export type RegisterDeps = {
  ctx: OneSatContext;
  fetch: Fetch;
  mineChar?: MineChar;
  /** Injected for tests; defaults to the real mintStep. */
  mint?: typeof mintStep;
  load?: typeof loadNode;
  /** Local mine-tree cache: our own (maybe unconfirmed) nodes, preferred over the indexer. See opnsTree.ts. */
  tree?: OpnsTree;
  /**
   * CLI (vault/gift routing): the address a newly mined name's inscription is locked to, when it must not stay in
   * this wallet. Undefined = the wallet's own ordinal key, exactly as in bWalletX.
   */
  lockTo?: (newDomain: string) => string | undefined;
  /** CLI: one-line notes about what the minter is doing (ghost nodes dropped, …). */
  log?: (msg: string) => void;
  now?: () => number;
};

const errText = (e: unknown) => {
  const o = (e ?? {}) as { name?: unknown; code?: unknown };
  return `${String(o.name ?? '')} ${String(o.code ?? '')} ${String(e)}`;
};
/** A rejected broadcast for a node that's already spent (incl. the wallet's WERR_REVIEW_ACTIONS on a double-spend). */
export const isDoubleSpend = (e: unknown) =>
  /double|spent|conflict|missing.?inputs|DOUBLE_SPEND|SEEN_IN_ORPHAN|REVIEW_ACTIONS|require review/i.test(errText(e));

type Start = { outpoint: string; domain: string; beefHint?: number[]; fromIndexer: boolean; txid?: string; at?: number };

/** Deepest unspent node for `name`: our own cached node when it is at least as deep as the indexer's. */
const pickNode = (tree: OpnsTree | undefined, name: string, indexed: MineNode | null): Start | null => {
  const local = tree?.best(name) ?? null;
  const idx = indexed && !tree?.isSpent(indexed.outpoint) ? indexed : null;
  if (local && (!idx || local.domain.length >= idx.domain.length))
    return { outpoint: local.outpoint, domain: local.domain, beefHint: tree?.beefFor(local), fromIndexer: false, txid: local.txid, at: local.at };
  if (idx) return { outpoint: idx.outpoint, domain: idx.domain, fromIndexer: true };
  return null;
};

/** The child node `domain` minted in the same tx as this restated parent (output 1), when that is what it is. */
const childOf = (node: LoadedNode, domain: string): string | null => {
  const out = node.tx.outputs[1];
  const st = node.vout === 0 && out ? OpNS.decode(out.lockingScript) : null;
  return st?.domain === domain ? `${node.tx.id('hex')}.1` : null;
};

/**
 * The 1Sat overlay can lag days behind the chain (14 Oct 2026: its "bo" node had been spent and re-stated by
 * others long ago, so every bo* name died of double-spends). Walk a node's spends forward on WhatsOnChain to the
 * live head: each spend is a mint whose output 0 re-states the same parent domain.
 */
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
export const followForward = async (f: Fetch, outpoint: string, maxHops = 60): Promise<string> => {
  let [txid, v] = outpoint.split(/[._]/);
  let vout = Number(v);
  let waits = 0;
  for (let hop = 0; hop < maxHops; ) {
    const res = await f(`${WOC}/tx/${txid}/${vout}/spent`).catch(() => null);
    if (!res) break;
    if (res.status === 429 && waits++ < 5) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!res.ok) break; // 404 = unspent: this is the head
    const j = (await res.json().catch(() => null)) as { txid?: string } | null;
    if (!j?.txid) break;
    txid = j.txid;
    vout = 0;
    hop++;
  }
  return `${txid}.${vout}`;
};

/** Load errors meaning the providers have never heard of the tx. */
export const isUnknownTx = (msg: string) => /must be valid transaction|unknown tx|not found|404/i.test(msg);
/** A cached node older than this that the chain doesn't know is a ghost, not lag. */
export const GHOST_MS = 30 * 60_000;

/** True only on a clear 404 from WhatsOnChain (a 429 / network error is "don't know", never "ghost"). */
export const txMissing = async (f: Fetch, txid: string) => {
  const r = await f(`${WOC}/tx/hash/${txid}`).catch(() => null);
  return r?.status === 404;
};

const catchingUp = (name: string) =>
  `The name tree for "${name}" is still catching up with your last mints. Wait for them to confirm (about 10 minutes), then try again.`;

export const mineName = async (
  deps: RegisterDeps,
  rawName: string,
  signal: AbortSignal,
  onProgress: (p: Progress) => void,
): Promise<MintStepResult[]> => {
  const name = rawName.trim().toLowerCase();
  if (!OPNS_CHARSET.test(name)) throw new Error('Names use a-z, 0-9 and - only');
  const mineChar = deps.mineChar ?? defaultMineChar;
  const mint = deps.mint ?? mintStep;
  const load = deps.load ?? loadNode;
  const tree = deps.tree;

  // Already minted by us (maybe unconfirmed, so the indexer doesn't know yet): nothing to do.
  if (tree?.isOurs(name)) return [];
  if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
  const indexed = await fetchMineNode(deps.fetch, name);
  // The overlay already has a node for the whole name and it is not ours: someone (or another of our machines)
  // mined it and the name index has not caught up. Taken, not "catching up".
  if (indexed && indexed.domain === name) throw new NameTakenError(name);
  const first = pickNode(tree, name, indexed);
  if (!first) throw new Error(indexed ? catchingUp(name) : `No mine-tree node found for "${name}"`);

  const totalChars = name.length - first.domain.length;
  const steps: MintStepResult[] = [];
  let outpoint = first.outpoint;
  if (first.fromIndexer) {
    const head = await followForward(deps.fetch, first.outpoint);
    if (head !== first.outpoint) {
      tree?.markSpent(first.outpoint);
      outpoint = head;
    }
  }
  let beefHint = first.beefHint;
  let fromIndexer = first.fromIndexer; // the node came from the overlay (vs our own fresh/cached child)
  let retries = 0;
  // The cached start node, while we are still on it: if the chain has never seen its tx it is a ghost.
  let cached: Start | null = first.fromIndexer ? null : first;
  let ghosts = 0;
  const now = deps.now ?? Date.now;

  while (true) {
    if (signal.aborted) throw new MiningCancelled();
    let node: LoadedNode;
    try {
      node = await load(deps.ctx, outpoint, beefHint);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const c = cached;
      if (!c?.txid || !tree || c.outpoint !== outpoint || ghosts >= 5 || !isUnknownTx(msg)) throw e;
      if (now() - (c.at ?? now()) < GHOST_MS || !(await txMissing(deps.fetch, c.txid))) throw e;
      deps.log?.(`Cached node "${c.domain}" (${c.txid.slice(0, 12)}…) never reached the chain: dropping it and starting from the indexer`);
      tree.forget(c.txid);
      ghosts++;
      const next = pickNode(tree, name, await fetchMineNode(deps.fetch, name));
      if (!next) throw new Error(catchingUp(name));
      outpoint = next.outpoint;
      beefHint = next.beefHint;
      fromIndexer = next.fromIndexer;
      cached = next.fromIndexer ? null : next;
      if (next.fromIndexer) {
        const head = await followForward(deps.fetch, next.outpoint);
        if (head !== next.outpoint) {
          tree.markSpent(next.outpoint);
          outpoint = head;
        }
      }
      continue;
    }
    cached = null;
    const domain = node.state.domain;
    if (!name.startsWith(domain)) throw new Error(`Tree node "${domain}" isn't a prefix of "${name}"`);
    if (domain === name) break;
    const char = name.charCodeAt(domain.length);
    if (isCharClaimed(node.state.claimed, char)) {
      // This node already has our next char mined (e.g. it is the restated parent of our own unconfirmed mint
      // and the cache / indexer pointed back at it). Mining it again fails the covenant: go to the child.
      const child = childOf(node, domain + name[domain.length]);
      // The claimed char completes the name and we hold nothing for it: the name is somebody's already.
      if (domain.length + 1 === name.length && !tree?.isOurs(name)) throw new NameTakenError(name);
      if (!child || tree?.isSpent(child)) {
        // A claimed char on a node the overlay handed us, and no child of ours: someone else (or another of our
        // machines) mined it and the name index has not caught up. Taken, not "catching up" (14 Oct 2026: the
        // laptop spent 90 minutes retrying names the Mac mini had already minted).
        if (fromIndexer && !tree?.isOurs(name)) throw new NameTakenError(name);
        throw new Error(catchingUp(name));
      }
      if (retries++ >= 3) throw new Error(catchingUp(name));
      outpoint = child;
      beefHint = node.beef;
      fromIndexer = false;
      continue;
    }
    const charIndex = Math.max(0, domain.length - first.domain.length);
    const remainingAfter = name.length - domain.length - 1;

    const { nonce, hash } = await mineChar(node.state.pow, char, signal, (tried, rate) =>
      onProgress({
        phase: 'mining',
        domain,
        charIndex,
        charsTotal: totalChars,
        tried,
        rate,
        etaSeconds:
          rate > 0 ? Math.max(0, EXPECTED_HASHES - tried) / rate + (remainingAfter * EXPECTED_HASHES) / rate : Infinity,
      }),
    );
    if (signal.aborted) throw new MiningCancelled();

    // Re-check the tree right before broadcasting.
    if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
    if (fromIndexer) {
      const live = await fetchMineNode(deps.fetch, name);
      const usable = live && !tree?.isSpent(live.outpoint);
      if (usable && live.domain === domain && live.outpoint !== node.outpoint) {
        // Someone spent our node (mined another char from it). Seed changed: re-mine from the new node.
        outpoint = live.outpoint;
        beefHint = undefined;
        continue;
      }
      if (usable && live.domain.length > domain.length) {
        // Someone extended the tree along our path; continue from their node.
        outpoint = live.outpoint;
        beefHint = undefined;
        continue;
      }
    }

    onProgress({ phase: 'broadcasting', domain, charIndex, charsTotal: totalChars, tried: 0, rate: 0, etaSeconds: 0 });
    let step: MintStepResult;
    try {
      step = await mint(deps.ctx, node, char, nonce, hash, deps.lockTo?.(domain + String.fromCharCode(char)));
    } catch (e) {
      if (!isDoubleSpend(e)) throw e;
      // That node is gone (spent by someone, maybe our own unconfirmed mint): never try it again.
      tree?.markSpent(node.outpoint);
      if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
      const head = await followForward(deps.fetch, node.outpoint);
      if (head !== node.outpoint && retries++ < 6) {
        outpoint = head;
        beefHint = undefined;
        fromIndexer = true;
        continue;
      }
      const next = pickNode(tree, name, await fetchMineNode(deps.fetch, name));
      if (retries++ >= 3 || !next || next.outpoint === node.outpoint) throw new Error(catchingUp(name));
      outpoint = next.outpoint;
      beefHint = next.beefHint;
      fromIndexer = next.fromIndexer;
      continue;
    }
    tree?.record(node.outpoint, domain, step);
    steps.push(step);
    if (step.newDomain === name) break;
    outpoint = step.childOutpoint;
    beefHint = step.tx ? Transaction.fromAtomicBEEF(step.tx).toBEEF() : undefined;
    fromIndexer = !beefHint;
  }
  onProgress({
    phase: 'done',
    domain: name,
    charIndex: totalChars,
    charsTotal: totalChars,
    tried: 0,
    rate: 0,
    etaSeconds: 0,
  });
  return steps;
};

/** Poll the overlay until the name's origin is indexed (i.e. the mint was accepted). */
export const waitForOrigin = async (
  f: Fetch,
  name: string,
  signal: AbortSignal,
  timeoutMs = 180_000,
  everyMs = 5000,
) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (signal.aborted) return false;
    if (await isTaken(f, name).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
};

export const formatEta = (s: number) => {
  if (!Number.isFinite(s)) return 'estimating…';
  if (s < 60) return `~${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `~${Math.round(s / 60)} min`;
  return `~${(s / 3600).toFixed(1)} h`;
};
