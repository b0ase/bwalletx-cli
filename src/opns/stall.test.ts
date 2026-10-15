// 15 Oct 2026: the bulk run stalled ~17 h on ghost cache nodes ("per", "tall": txs that never reached the chain)
// while printing nothing. These pin the fix: ghosts are dropped, every wait says what it waits for.
import { describe, expect, test } from 'vitest';
import type { Transaction } from '@bsv/sdk';
import { OpnsTree, type KV } from './opnsTree.js';
import { mineName, GHOST_MS, type MineChar } from './opnsRegister.js';
import { loudSleep, waitForNextBlock, HEARTBEAT_MS } from './batch.js';
import type { Fetch } from './services.js';

const memKV = (): KV => {
  let v: string | null = null;
  return { getItem: () => v, setItem: (_k, x) => (v = x) };
};
const G = 'e'.repeat(64); // ghost txid
const IDX = 'a'.repeat(64); // indexer's confirmed "pe" node
const fakeNode = (outpoint: string, domain: string) => ({
  outpoint,
  beef: [],
  tx: {} as Transaction,
  vout: 1,
  state: { claimed: [0], domain, pow: new Array(32).fill(1) },
});
const instantMiner: MineChar = async () => ({ nonce: new Array(32).fill(0), hash: new Array(32).fill(0) });

describe('OpnsTree.forget', () => {
  test('drops the ghost nodes and un-marks the outpoint the ghost claimed to spend', () => {
    let t = 1000;
    const tree = new OpnsTree(memKV(), 'k', () => t);
    tree.record(`${IDX}.1`, 'pe', { txid: G, newDomain: 'per', childOutpoint: `${G}.1` });
    expect(tree.isSpent(`${IDX}.1`)).toBe(true);
    expect(tree.best('permissionless')?.domain).toBe('per');
    t = 2000;
    tree.markSpent(`${'f'.repeat(64)}.0`); // an unrelated spend survives
    expect(tree.forget(G)).toBe(true);
    expect(tree.best('permissionless')).toBeNull();
    expect(tree.isSpent(`${IDX}.1`)).toBe(false);
    expect(tree.isSpent(`${'f'.repeat(64)}.0`)).toBe(true);
    expect(tree.isOurs('per')).toBe(false);
    expect(tree.forget(G)).toBe(false);
  });
});

describe('mineName ghost cache node', () => {
  const routes = (woc404: boolean): Fetch => async (url) => {
    if (url.includes(`/tx/hash/${G}`)) return new Response('', { status: woc404 ? 404 : 200 });
    if (url.endsWith('/mine/permi')) return new Response(JSON.stringify({ outpoint: `${IDX}.1`, domain: 'pe' }));
    if (url.includes('/spent')) return new Response('', { status: 404 });
    return new Response('{}', { status: 404 });
  };
  const setup = (age: number) => {
    let t = 0;
    const tree = new OpnsTree(memKV(), 'k', () => t);
    tree.record(`${IDX}.1`, 'pe', { txid: G, newDomain: 'per', childOutpoint: `${G}.1` });
    t = age;
    return { tree, now: () => t };
  };
  const load = async (_c: unknown, op: string) => {
    if (op.startsWith(G)) throw new Error(`The txid ${G} parameter must be valid transaction on chain main`);
    return fakeNode(op, op.startsWith(IDX) ? 'pe' : op.startsWith('b'.repeat(64)) ? 'per' : op.startsWith('c'.repeat(64)) ? 'perm' : 'permi');
  };
  const mint = async (_c: unknown, n: ReturnType<typeof fakeNode>, ch: number) => {
    const d = n.state.domain + String.fromCharCode(ch);
    const txid = ({ per: 'b', perm: 'c', permi: 'd' } as Record<string, string>)[d]!.repeat(64);
    return { txid, newDomain: d, childOutpoint: `${txid}.1` };
  };

  test('an old cached node the chain has never seen is dropped and minting restarts from the indexer', async () => {
    const { tree, now } = setup(GHOST_MS + 1);
    const logs: string[] = [];
    const steps = await mineName(
      { ctx: {} as never, fetch: routes(true), tree, now, mineChar: instantMiner, load: load as never, mint: mint as never, log: (m) => logs.push(m) },
      'permi',
      new AbortController().signal,
      () => undefined,
    );
    expect(steps.map((s) => s.newDomain)).toEqual(['per', 'perm', 'permi']);
    expect(logs.some((l) => /never reached the chain/.test(l))).toBe(true);
  });

  test('a young cached node is lag, not a ghost: the error goes back to the retry ladder', async () => {
    const { tree, now } = setup(60_000);
    await expect(
      mineName({ ctx: {} as never, fetch: routes(true), tree, now, mineChar: instantMiner, load: load as never, mint: mint as never }, 'permi', new AbortController().signal, () => undefined),
    ).rejects.toThrow(/must be valid transaction/);
    expect(tree.best('permi')?.domain).toBe('per');
  });

  test('no clear 404 from WhatsOnChain: never dropped', async () => {
    const { tree, now } = setup(GHOST_MS + 1);
    await expect(
      mineName({ ctx: {} as never, fetch: routes(false), tree, now, mineChar: instantMiner, load: load as never, mint: mint as never }, 'permi', new AbortController().signal, () => undefined),
    ).rejects.toThrow(/must be valid transaction/);
    expect(tree.best('permi')?.domain).toBe('per');
  });
});

describe('loud waits', () => {
  test('loudSleep says what it waits for every heartbeat', async () => {
    const logs: string[] = [];
    const slept: number[] = [];
    await loudSleep(async (ms) => void slept.push(ms), 90_000, 'retrying "x"', new AbortController().signal, (m) => logs.push(m));
    expect(slept).toEqual([HEARTBEAT_MS, HEARTBEAT_MS, HEARTBEAT_MS]);
    expect(logs).toEqual(['retrying "x" (90 s left)', 'retrying "x" (60 s left)', 'retrying "x" (30 s left)']);
  });

  test('waitForNextBlock logs every poll', async () => {
    let h = 100;
    const f = (async () => new Response(JSON.stringify({ blocks: h }))) as unknown as Fetch;
    const logs: string[] = [];
    let n = 0;
    await waitForNextBlock(f, async () => void (++n === 3 && (h = 101)), new AbortController().signal, 30 * 60_000, 30_000, (m) => logs.push(m));
    expect(logs.length).toBe(3);
    expect(logs[0]).toMatch(/Waiting for the next block \(height 100/);
  });
});
