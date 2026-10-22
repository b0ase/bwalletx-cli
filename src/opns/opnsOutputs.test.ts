import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { usdToSats } from './batch.js';
import {
  findAfterCancel,
  listAllPaged,
  loadRelistProgress,
  nameOfOutput,
  planRelist,
  remaining,
  saveRelistProgress,
  unlistedIdFor,
  type OpnsOutput,
} from './opnsOutputs.js';

const listed = (name: string, sats: number, i = 0): OpnsOutput => ({
  outpoint: `${String(i).padStart(64, 'a')}.0`,
  tags: ['opns', 'ordlock', `price:${sats}`, `id:${name}id`],
  customInstructions: JSON.stringify({ name }),
});

describe('listAllPaged', () => {
  test('pages past 10,000 outputs', async () => {
    const all = Array.from({ length: 12_345 }, (_, i) => ({ outpoint: `t${i}.0` }));
    const calls: number[] = [];
    const got = await listAllPaged(async (offset, limit) => {
      calls.push(offset);
      return { outputs: all.slice(offset, offset + limit), totalOutputs: all.length };
    }, 5_000);
    expect(got).toHaveLength(12_345);
    expect(got.at(-1)!.outpoint).toBe('t12344.0');
    expect(calls).toEqual([0, 5_000, 10_000]);
  });
  test('exact multiple with no total stops on the empty page', async () => {
    const all = Array.from({ length: 20 }, (_, i) => ({ outpoint: `t${i}.0` }));
    const got = await listAllPaged(async (offset, limit) => ({ outputs: all.slice(offset, offset + limit) }), 10);
    expect(got).toHaveLength(20);
  });
});

describe('names on outputs', () => {
  test('cancelled output: name from customInstructions, found by unlistedIdFor', () => {
    const back: OpnsOutput = { outpoint: 'c'.repeat(64) + '.0', tags: ['opns'], customInstructions: JSON.stringify({ name: 'Paris' }) };
    expect(nameOfOutput(back)).toBe('paris');
    expect(unlistedIdFor([listed('paris', 5), back], 'paris')).toBe(back.outpoint);
    expect(unlistedIdFor([listed('paris', 5)], 'paris')).toBeUndefined();
  });
});

describe('findAfterCancel', () => {
  const txid = 'f'.repeat(64);
  const hit = { outpoint: `${txid}.0`, tags: ['opns'] };
  test('found late', async () => {
    let n = 0;
    let pokes = 0;
    const r = await findAfterCancel(async () => (++n >= 4 ? [hit] : []), txid, { sleep: async () => undefined, poke: async () => pokes++ });
    expect(r).toBe(hit);
    expect(n).toBe(4);
    expect(pokes).toBe(3);
  });
  test('never found → undefined after the bounded wait', async () => {
    let n = 0;
    const slept: number[] = [];
    const r = await findAfterCancel(async () => (n++, []), txid, { maxMs: 30_000, everyMs: 2_000, sleep: async (ms) => void slept.push(ms) });
    expect(r).toBeUndefined();
    expect(slept.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(n).toBe(16);
  });
});

describe('planRelist', () => {
  const rate = 50; // $/BSV
  const s = (usd: number) => usdToSats(usd, rate);
  const outs = [
    listed('london', s(2), 1), // 5+: $2 → $10
    listed('abcd', s(50), 2), // at tier
    listed('abc', s(20), 3), // $20 → $100
    listed('xy', s(1000), 4), // premium above $500
    { outpoint: 'u.0', tags: ['opns', 'name:free'] }, // not listed
    { outpoint: 'p.0', tags: ['opns', 'ordlock'], customInstructions: JSON.stringify({ name: 'noprice' }) },
  ];
  test('--all: changes cheap listings, keeps tier and premium', () => {
    const p = planRelist(outs, rate);
    expect(p.change.map((c) => [c.name, c.oldSats, c.newSats])).toEqual([
      ['london', s(2), s(10)],
      ['abc', s(20), s(100)],
    ]);
    expect(p.same).toBe(1);
    expect(p.premium).toEqual(['xy']);
    expect(p.unknownPrice).toEqual(['noprice']);
    expect(p.change[0].id).toBe('londonid');
  });
  test('--file names a premium listing → relisted; unknown names reported', () => {
    const p = planRelist(outs, rate, { only: new Set(['xy', 'nope']) });
    expect(p.change.map((c) => c.name)).toEqual(['xy']);
    expect(p.notListed).toEqual(['nope']);
  });
  test('length range', () => {
    const p = planRelist(outs, rate, { minLen: 5 });
    expect(p.change.map((c) => c.name)).toEqual(['london']);
    expect(p.outOfRange).toBe(3);
  });
});

describe('relist progress', () => {
  test('resume skips done names', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'relist-')), 'p.json');
    const p = loadRelistProgress(path, 'acct');
    expect(p.done).toEqual({});
    p.done.london = { txid: 't', at: 1 };
    saveRelistProgress(path, p);
    const again = loadRelistProgress(path, 'acct');
    const plan = planRelist([listed('london', 1, 1), listed('paris', 1, 2)], 50);
    expect(remaining(plan.change, again).map((i) => i.name)).toEqual(['paris']);
  });
});
