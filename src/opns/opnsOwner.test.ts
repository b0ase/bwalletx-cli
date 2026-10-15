import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildQueue, newState, runHeadless, type RunDeps } from './batch.js';
import { appendLedger, ledgerNames, ownerCheck, parseLedger, PRE_2024_HEIGHT } from './opnsOwner.js';
import type { Fetch } from './services.js';

/** Mocked indexers: every name is taken; its origin was inscribed at `height` (null = lookups fail). */
const chain = (height: number | null, calls: string[] = []): Fetch => async (url) => {
  calls.push(url);
  if (height === null) throw new Error('network down');
  if (url.includes('/opns/origin/')) return new Response(JSON.stringify({ outpoint: `${'c'.repeat(64)}.2` }));
  if (url.includes('/api/txos/')) return new Response(JSON.stringify({ height, owner: '1Fresh' }));
  return new Response('{}', { status: 404 });
};

describe('ledger', () => {
  test('parse ignores comments, blanks and junk', () => {
    expect(parseLedger('b0ase  # 13 Oct\n\nBChatX\nbad name\n# only a comment')).toEqual(['b0ase', 'bchatx']);
  });
  test('merges opns-ours.txt, batch states (done/minted) and tree caches; append works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opns-ours-'));
    writeFileSync(join(dir, 'opns-ours.txt'), 'b0ase\n');
    writeFileSync(
      join(dir, 'opns-batch-mini.json'),
      JSON.stringify({ items: [{ name: 'aa', status: 'done', txids: ['t'] }, { name: 'bb', status: 'skipped', txids: [] }, { name: 'cc', status: 'mine', txids: [] }] }),
    );
    writeFileSync(join(dir, 'opns-tree-mini.json'), JSON.stringify({ names: { dd: 1 } }));
    appendLedger(dir, ['EE'], 'minted by laptop');
    expect([...ledgerNames(dir)].sort()).toEqual(['aa', 'b0ase', 'dd', 'ee']);
    expect(readFileSync(join(dir, 'opns-ours.txt'), 'utf8')).toMatch(/^ee {2}# .* minted by laptop$/m);
  });
});

describe('ownerCheck', () => {
  test('ours: in the ledger (no network)', async () => {
    const calls: string[] = [];
    const v = ownerCheck({ fetch: chain(900_000, calls), ledger: () => new Set(['b0ase']) });
    expect(await v('B0ase')).toBe('ours');
    expect(calls).toEqual([]);
  });
  test('ours: in our BRC-100 wallet', async () => {
    const v = ownerCheck({ fetch: chain(900_000), ledger: () => new Set(), inWallet: async (n) => n === 'bmint' });
    expect(await v('bmint')).toBe('ours');
  });
  test('someone else: only a pre-2024 holder', async () => {
    const v = ownerCheck({ fetch: chain(PRE_2024_HEIGHT - 1), ledger: () => new Set() });
    expect(await v('bitcoin')).toBe('theirs');
  });
  test('recent holder not in our records: unverified, never "someone else"', async () => {
    const v = ownerCheck({ fetch: chain(969_000), ledger: () => new Set() });
    expect(await v('newname')).toBe('unverified');
  });
  test('lookup failure: unverified; cached per run', async () => {
    const calls: string[] = [];
    const v = ownerCheck({ fetch: chain(null, calls), ledger: () => new Set() });
    expect(await v('x')).toBe('unverified');
    expect(await v('x')).toBe('unverified');
    expect(calls.length).toBe(1);
  });
});

describe('batch with takenOwner', () => {
  const run = async (verdict: 'ours' | 'theirs' | 'unverified') => {
    const taken: Fetch = async (url) =>
      url.includes('/origin/') ? new Response(JSON.stringify({ outpoint: 'x.1' })) : new Response('{}', { status: 404 });
    const minted: string[] = [];
    const deps: RunDeps = {
      fetch: taken,
      mine: async (n) => (minted.push(n), []),
      list: async () => 'l',
      isListed: async () => false,
      rate: async () => 50,
      charsNeeded: async (n) => n.length,
      isOurs: () => false,
      takenOwner: async () => verdict,
      perCharSats: 1000,
      listFeeSats: 200,
      save: () => undefined,
      onUpdate: () => undefined,
      sleep: async () => undefined,
    };
    const s = newState('agent', buildQueue([['b0ase']]), { budgetSats: 1e9 });
    const r = await runHeadless(deps, s, new AbortController().signal);
    expect(minted).toEqual([]);
    return r.state.items[0];
  };
  test('ours → mine', async () => {
    expect(await run('ours')).toMatchObject({ status: 'mine', note: expect.stringMatching(/Already yours/) });
  });
  test('theirs → skipped, someone else', async () => {
    expect(await run('theirs')).toMatchObject({ status: 'skipped', note: expect.stringMatching(/someone else/) });
  });
  test('unverified → skipped, unverified owner', async () => {
    expect(await run('unverified')).toMatchObject({ status: 'skipped', note: 'Taken (unverified owner)' });
  });
});
