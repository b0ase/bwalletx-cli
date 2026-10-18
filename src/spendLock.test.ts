import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bwx-lock-'));
  process.env.BWALLETX_HOME = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('withSpendLock', () => {
  it('runs spends on one account one at a time', async () => {
    const { withSpendLock } = await import('./store.js');
    let inside = 0;
    let most = 0;
    const job = () =>
      withSpendLock('a1', async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside--;
      });
    await Promise.all([job(), job(), job()]);
    expect(most).toBe(1);
  });

  it('releases on error and lets other accounts run', async () => {
    const { withSpendLock } = await import('./store.js');
    await expect(withSpendLock('a2', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(withSpendLock('a2', async () => 7)).resolves.toBe(7);
  });

  it('waits for a lock held by another process, then gives up; takes over a stale one', async () => {
    const { withSpendLock } = await import('./store.js');
    const held = join(dir, 'locks', 'a3.spend');
    mkdirSync(held, { recursive: true });
    await expect(withSpendLock('a3', async () => 1, { waitMs: 300 })).rejects.toThrow(/still running/);
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(held, old, old);
    await expect(withSpendLock('a3', async () => 2, { waitMs: 300 })).resolves.toBe(2);
  });

  it('takes over a lock whose owner process is dead, but not one held by a live process', async () => {
    const { withSpendLock } = await import('./store.js');
    const held = join(dir, 'locks', 'a4.spend');
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, 'pid'), String(process.ppid));
    await expect(withSpendLock('a4', async () => 1, { waitMs: 300 })).rejects.toThrow(/still running/);
    writeFileSync(join(held, 'pid'), '999999');
    await expect(withSpendLock('a4', async () => 2, { waitMs: 300 })).resolves.toBe(2);
  });

  it('keeps a long-running spend fresh so it is not taken over as stale', async () => {
    const { withSpendLock } = await import('./store.js');
    let inside = 0;
    let most = 0;
    const job = () =>
      withSpendLock(
        'a5',
        async () => {
          inside++;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 2500));
          inside--;
        },
        { staleMs: 1500, waitMs: 6000 },
      );
    // Second caller in a separate module instance would be another process; here the in-process chain
    // already serialises, so check the heartbeat directly: the lock's mtime stays fresh while held.
    const p1 = job();
    await new Promise((r) => setTimeout(r, 2000));
    const { statSync } = await import('node:fs');
    expect(Date.now() - statSync(join(dir, 'locks', 'a5.spend')).mtimeMs).toBeLessThan(1500);
    await p1;
    expect(most).toBe(1);
  }, 10_000);
});
