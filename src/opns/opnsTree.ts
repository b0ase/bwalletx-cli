// Copied from bWalletX src/mobile/names/opnsTree.ts (13 Oct 2026, bWalletX commit 4e7f6e2c). Keep behaviour identical;
// fix bugs in both places. Only import paths / platform glue differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { Transaction, Utils } from '@bsv/sdk';
import type { MintStepResult } from './opnsMint.js';

/**
 * Local mine-tree cache (bug 13 Oct 2026). The indexer (api.1sat.app opns/mine, opns/origin) only knows
 * CONFIRMED names, so after minting b0a → b0as → b0ase (all unconfirmed) a lookup for b0asex still
 * returned node "b0" — already spent by our own mempool tx — and the wallet refused the double-spend
 * (WERR_REVIEW_ACTIONS). Every successful mint step is recorded here: the child node (prefix + char,
 * output 1), the restated parent node (output 0), the BEEF with its unconfirmed ancestry, and the
 * outpoint it spent. Minting prefers the deepest unspent local node over the indexer's answer and never
 * reuses an outpoint we know is spent. Saved per identity, so a reload / Resume keeps it.
 */

export type CachedNode = { domain: string; outpoint: string; txid: string; beef?: string; at: number };
export type TreeState = {
  v: 1;
  nodes: Record<string, CachedNode>;
  spent: Record<string, number>;
  names: Record<string, number>;
};

export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

const KEEP_MS = 14 * 24 * 3600 * 1000;
/** A spent mark only has to outlive the mempool: after confirmation the indexer has moved past it. */
const SPENT_MS = 2 * 24 * 3600 * 1000;
const norm = (op: string) => op.replace('_', '.');
const empty = (): TreeState => ({ v: 1, nodes: {}, spent: {}, names: {} });

export class OpnsTree {
  private s: TreeState;

  constructor(
    private kv: KV | null = null,
    private key = '',
    private now: () => number = Date.now,
  ) {
    this.s = this.load();
  }

  private load(): TreeState {
    try {
      const s = JSON.parse(this.kv?.getItem(this.key) ?? 'null') as TreeState | null;
      if (!s || s.v !== 1 || typeof s.nodes !== 'object') return empty();
      const cutoff = this.now() - KEEP_MS;
      const nodes = Object.fromEntries(Object.entries(s.nodes).filter(([, n]) => n.at >= cutoff));
      const names = Object.fromEntries(Object.entries(s.names ?? {}).filter(([, at]) => at >= cutoff));
      const spentCut = this.now() - SPENT_MS;
      const spent = Object.fromEntries(
        Object.entries(s.spent && !Array.isArray(s.spent) ? s.spent : {}).filter(([, at]) => at >= spentCut),
      );
      return { v: 1, nodes, spent, names };
    } catch {
      return empty();
    }
  }

  private save() {
    try {
      this.kv?.setItem(this.key, JSON.stringify(this.s));
    } catch {
      /* storage unavailable: the cache still works for this session */
    }
  }

  isSpent(outpoint: string) {
    return norm(outpoint) in this.s.spent;
  }

  markSpent(outpoint: string) {
    const op = norm(outpoint);
    if (this.isSpent(op)) return;
    this.s.spent[op] = this.now();
    for (const [d, n] of Object.entries(this.s.nodes)) if (n.outpoint === op) delete this.s.nodes[d];
    this.save();
  }

  /** A name we minted recently (maybe still unconfirmed): ours / in progress, never "free". */
  isOurs(name: string) {
    return name in this.s.names;
  }

  /** The deepest unspent node we created whose domain is a prefix of `name` (or `name` itself). */
  best(name: string): CachedNode | null {
    for (let n = name.length; n >= 1; n--) {
      const c = this.s.nodes[name.slice(0, n)];
      if (c && !this.isSpent(c.outpoint)) return c;
    }
    return null;
  }

  beefFor(c: CachedNode): number[] | undefined {
    return c.beef ? Utils.toArray(c.beef, 'hex') : undefined;
  }

  /** After a mint step broadcast: `spent` (the node it consumed) is gone, outputs 0 and 1 are live nodes. */
  record(spent: string, parentDomain: string, step: MintStepResult) {
    let beef: string | undefined;
    try {
      beef = step.tx ? Utils.toHex(Transaction.fromAtomicBEEF(step.tx).toBEEF()) : undefined;
    } catch {
      beef = undefined;
    }
    const at = this.now();
    const op = norm(spent);
    this.s.spent[op] = at;
    this.s.nodes[parentDomain] = { domain: parentDomain, outpoint: `${step.txid}.0`, txid: step.txid, beef, at };
    this.s.nodes[step.newDomain] = { domain: step.newDomain, outpoint: step.childOutpoint, txid: step.txid, beef, at };
    this.s.names[step.newDomain] = at;
    this.save();
  }
}

/** CLI: the tree cache in a JSON file next to the batch state (~/.bwalletx/opns-tree-<account>.json). */
export const fileKV = (file: string): KV => ({
  getItem: () => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  setItem: (_k, v) => writeFileSync(file, v, { mode: 0o600 }),
});
