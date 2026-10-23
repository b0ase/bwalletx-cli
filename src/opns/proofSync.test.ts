import { describe, expect, test } from 'vitest';
import { beefDepthHelp, isBeefDepth, PROOF_TASKS, retryOnBeefDepth, syncProofs } from './proofSync.js';

const DEPTH = 'WERR_INVALID_OPERATION: Maximum BEEF depth exceeded. Limit is 12';

describe('syncProofs', () => {
  test('feeds the chain tip to the monitor, then runs the proof tasks once', async () => {
    const calls: string[] = [];
    let unproven = 22;
    const r = await syncProofs({
      unproven: async () => unproven,
      tip: async () => ({ height: 971900, hash: 'ab'.repeat(32) }),
      newHeader: (h) => calls.push(`header ${h.height}`),
      runTask: async (t) => {
        calls.push(t);
        if (t === 'CheckForProofs') unproven = 1;
        return '';
      },
    });
    expect(calls).toEqual(['header 971900', ...PROOF_TASKS]);
    expect(r).toEqual({ height: 971900, before: 22, after: 1, proven: 21 });
  });

  test('nothing unproven: no tasks run', async () => {
    const calls: string[] = [];
    const r = await syncProofs({
      unproven: async () => 0,
      tip: async () => ({ height: 1, hash: '00' }),
      newHeader: () => calls.push('header'),
      runTask: async (t) => (calls.push(t), ''),
    });
    expect(calls).toEqual([]);
    expect(r.proven).toBe(0);
  });
});

describe('retryOnBeefDepth', () => {
  test('thrown depth error: syncs and retries once', async () => {
    let n = 0;
    let synced = 0;
    const r = await retryOnBeefDepth(
      async () => {
        if (n++ === 0) throw new Error(DEPTH);
        return { txid: 'ok' };
      },
      async () => synced++,
    );
    expect(r).toEqual({ txid: 'ok' });
    expect(n).toBe(2);
    expect(synced).toBe(1);
  });

  test('returned { error } depth: syncs and retries once', async () => {
    let n = 0;
    const r = await retryOnBeefDepth(async () => (n++ === 0 ? { error: DEPTH } : { txid: 't' }), async () => undefined);
    expect(r).toEqual({ txid: 't' });
  });

  test('retries only once', async () => {
    let n = 0;
    await expect(
      retryOnBeefDepth(async () => {
        n++;
        throw new Error(DEPTH);
      }, async () => undefined),
    ).rejects.toThrow(/BEEF depth/);
    expect(n).toBe(2);
  });

  test('other errors and no syncer pass straight through', async () => {
    let n = 0;
    await expect(retryOnBeefDepth(async () => (n++, Promise.reject(new Error('insufficient funds'))), async () => undefined)).rejects.toThrow('insufficient funds');
    await expect(retryOnBeefDepth(async () => (n++, Promise.reject(new Error(DEPTH))), undefined)).rejects.toThrow(/BEEF depth/);
    expect(n).toBe(2);
  });
});

test('isBeefDepth / help', () => {
  expect(isBeefDepth(DEPTH)).toBe(true);
  expect(isBeefDepth('merged Beef failed validation.')).toBe(false);
  expect(beefDepthHelp(DEPTH)).toMatch(/bwalletx sync/);
  expect(beefDepthHelp('x')).toBe('x');
});
