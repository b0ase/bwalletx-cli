import { describe, expect, test, vi } from 'vitest';
import {
  isTreeWait,
  treeWaitMs,
  buildQueue,
  isTransient,
  mergeState,
  newState,
  parseNameList,
  runHeadless,
  summarise,
  tierUsd,
  usdToSats,
  type MineFn,
  type RunDeps,
  type State,
} from './batch.js';
import { MiningCancelled } from './opnsRegister.js';
import type { Fetch } from './services.js';

const free: Fetch = async (url) =>
  url.includes('/origin/') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ outpoint: `${'a'.repeat(64)}.1`, domain: '' }));
const takenFetch =
  (taken: string[]): Fetch =>
  async (url) => {
    const n = decodeURIComponent(url.split('/').pop() ?? '');
    return url.includes('/origin/') && taken.includes(n) ? new Response(JSON.stringify({ outpoint: 'x.1' })) : new Response('{}', { status: 404 });
  };

/** A fake chain: mining a name costs one character per letter beyond what is already ours. */
const harness = (o: Partial<RunDeps> & { taken?: string[]; failOn?: string | string[]; cancelOn?: string } = {}) => {
  const ours = new Set<string>();
  const minted: { name: string; lockTo?: string }[] = [];
  const listed: { name: string; sats: number }[] = [];
  let saved: State | null = null;
  const ctl = new AbortController();
  const mine: MineFn = async (name, lockTo) => {
    if (name === o.cancelOn) {
      ctl.abort();
      throw new MiningCancelled();
    }
    if (o.failOn && (Array.isArray(o.failOn) ? o.failOn.includes(name) : name === o.failOn)) throw new Error('OpNS covenant check failed locally, not broadcast: OP_VERIFY failed');
    const steps = [];
    let from = 0;
    for (let k = name.length - 1; k > 0; k--) if (ours.has(name.slice(0, k))) (from = k), (k = 0);
    for (let k = Math.max(from, 0) + 1; k <= name.length; k++) {
      const d = name.slice(0, k);
      ours.add(d);
      steps.push({ txid: `${d}-tx`, newDomain: d });
    }
    minted.push({ name, lockTo: lockTo(name) });
    return steps;
  };
  const deps: RunDeps = {
    fetch: o.taken ? takenFetch(o.taken) : free,
    mine,
    list: async (name, sats) => (listed.push({ name, sats }), `${name}-list`),
    isListed: async (name) => listed.some((l) => l.name === name),
    rate: async () => 50, // $50 per BSV
    charsNeeded: async (name) => name.length,
    isOurs: (name) => ours.has(name),
    perCharSats: 1000,
    listFeeSats: 200,
    save: (s) => (saved = JSON.parse(JSON.stringify(s))),
    onUpdate: () => undefined,
    sleep: async () => undefined,
    ...o,
  };
  return { deps, ours, minted, listed, ctl, saved: () => saved };
};

const state = (names: string[], o: { vault?: string[]; gift?: string[]; budget?: number } = {}) =>
  newState('agent', buildQueue([names], o.vault, o.gift), { to: '1Owner', budgetSats: o.budget ?? 1e9 });

describe('lists', () => {
  test('parse: lower-case, @/$ dropped, comments, commas, dupes removed, bad names reported', () => {
    const r = parseNameList('# my names\nAlice, $bob\n@carol  alice\nbad_name\n\nzed # trailing');
    expect(r.names).toEqual(['alice', 'bob', 'carol', 'zed']);
    expect(r.invalid).toEqual(['bad_name']);
  });
  test('merged lists are deduped and sorted so prefixes come first', () => {
    const q = buildQueue([['b0asex', 'zed', 'b0ase', 'b0as']]);
    expect(q.map((x) => x.name)).toEqual(['b0as', 'b0ase', 'b0asex', 'zed']);
  });
  test('vault and gift first, then each list in the order given', () => {
    const q = buildQueue([['words', 'apple'], ['aaa', 'zed']], ['zz'], ['yy']);
    expect(q.map((x) => x.name)).toEqual(['yy', 'zz', 'apple', 'words', 'aaa', 'zed']);
  });
  test('vault and gift names are minted too and routed to the owner, gift winning over vault', () => {
    const q = buildQueue([['alice', 'bob']], ['bob', 'keepme'], ['keepme', 'gifty']);
    expect(q).toEqual([
      { name: 'bob', route: 'vault' },
      { name: 'gifty', route: 'gift' },
      { name: 'keepme', route: 'gift' },
      { name: 'alice', route: 'sell' },
    ]);
  });
});

describe('tier pricing', () => {
  test('5+ chars $1, 4 chars $5, 3 or fewer $15', () => {
    expect(tierUsd('alice')).toBe(1);
    expect(tierUsd('longername')).toBe(1);
    expect(tierUsd('abcd')).toBe(5);
    expect(tierUsd('abc')).toBe(15);
    expect(tierUsd('ab')).toBe(15);
  });
  test('USD → sats rounds up at the live rate', () => {
    expect(usdToSats(1, 50)).toBe(2_000_000);
    expect(usdToSats(1, 33)).toBe(3_030_304);
    expect(() => usdToSats(1, 0)).toThrow();
  });
  test('listings use the tier price at the rate when listed', async () => {
    const h = harness();
    await runHeadless(h.deps, state(['abc', 'abcd', 'abcde']), h.ctl.signal);
    expect(h.listed).toEqual([
      { name: 'abc', sats: 30_000_000 },
      { name: 'abcd', sats: 10_000_000 },
      { name: 'abcde', sats: 2_000_000 },
    ]);
  });
});

describe('runHeadless', () => {
  test('vault/gift names are locked to --to and never listed; sale names stay ours and are listed', async () => {
    const h = harness();
    const r = await runHeadless(h.deps, state(['alice', 'bob', 'carol'], { vault: ['bob'], gift: ['carol'] }), h.ctl.signal);
    expect(r.stopped).toBe('finished');
    expect(h.minted).toEqual([
      { name: 'bob', lockTo: '1Owner' },
      { name: 'carol', lockTo: '1Owner' },
      { name: 'alice', lockTo: undefined },
    ]);
    expect(h.listed.map((l) => l.name)).toEqual(['alice']);
    const bob = r.state.items.find((i) => i.name === 'bob')!;
    expect(bob.listed).toBeUndefined();
    expect(summarise(r.state)).toMatchObject({ done: 3, vaulted: 2, listed: 1 });
  });

  test('lockTo only routes the vault name itself, never its prefixes', async () => {
    let routed: (string | undefined)[] = [];
    const h = harness();
    h.deps.mine = async (name, lockTo) => ((routed = ['ab', 'abc'].map(lockTo)), [{ txid: 't', newDomain: name }]);
    await runHeadless(h.deps, state(['abc'], { vault: ['abc'] }), h.ctl.signal);
    expect(routed).toEqual([undefined, '1Owner']);
  });

  test('stops cleanly before the name that would go over the budget, and resumes there with more budget', async () => {
    const h = harness();
    // alice 5 chars + listing = 5,200; bobby 5,200 → budget 12,000 covers two, not three.
    const r = await runHeadless(h.deps, state(['alice', 'bobby', 'carol'], { budget: 12_000 }), h.ctl.signal);
    expect(r.stopped).toBe('budget');
    expect(r.error).toMatch(/carol/);
    expect(h.minted.map((m) => m.name)).toEqual(['alice', 'bobby']);
    expect(r.state.items.map((i) => i.status)).toEqual(['done', 'done', 'pending']);
    expect(r.state.spentSats).toBe(10_400);
    const more = mergeState(r.state, [], { budgetSats: 20_000 });
    const r2 = await runHeadless(h.deps, more, h.ctl.signal);
    expect(r2.stopped).toBe('finished');
    expect(h.minted.map((m) => m.name)).toEqual(['alice', 'bobby', 'carol']);
  });

  test('stops when the account balance is too low (funds), nothing mined', async () => {
    const h = harness({ balance: async () => 100 });
    const r = await runHeadless(h.deps, state(['alice']), h.ctl.signal);
    expect(r.stopped).toBe('funds');
    expect(h.minted).toEqual([]);
  });

  test('taken names are skipped (re-checked right before mining)', async () => {
    const h = harness({ taken: ['bob'] });
    const r = await runHeadless(h.deps, state(['alice', 'bob']), h.ctl.signal);
    expect(r.state.items.find((i) => i.name === 'bob')?.status).toBe('skipped');
    expect(h.minted.map((m) => m.name)).toEqual(['alice']);
  });

  test('resume after a crash: done names are kept, a name mid-mine restarts, a mined-but-unlisted name gets listed', async () => {
    const h = harness();
    const s = state(['alice', 'bob', 'carol']);
    // Process died: alice done but not yet listed; bob was mid-mine (its chars are in the tree: ours); carol untouched.
    s.items[0] = { ...s.items[0], status: 'done', txids: ['a-tx'], chars: 5 };
    s.items[1] = { ...s.items[1], status: 'mining' };
    h.ours.add('alice');
    h.ours.add('bob');
    const resumed = mergeState(JSON.parse(JSON.stringify(s)), buildQueue([['alice', 'bob', 'carol', 'dave']]), {});
    expect(resumed.items.map((i) => `${i.name}:${i.status}`)).toEqual(['alice:done', 'bob:pending', 'carol:pending', 'dave:pending']);
    const r = await runHeadless(h.deps, resumed, h.ctl.signal);
    expect(r.stopped).toBe('finished');
    expect(h.minted.map((m) => m.name)).toEqual(['carol', 'dave']); // bob is already ours: never mined twice
    expect(r.state.items.find((i) => i.name === 'bob')?.status).toBe('mine');
    expect(h.listed.map((l) => l.name)).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(h.saved()?.items.every((i) => i.status !== 'pending')).toBe(true);
  });

  test('Ctrl-C: the current name stays pending and the run reports cancelled', async () => {
    const h = harness({ cancelOn: 'bob' });
    const r = await runHeadless(h.deps, state(['alice', 'bob', 'carol']), h.ctl.signal);
    expect(r.stopped).toBe('cancelled');
    expect(r.state.items.map((i) => i.status)).toEqual(['done', 'pending', 'pending']);
  });

  test('a mint the local covenant check blocks is noted and skipped: the run goes on, the name is retried next run', async () => {
    const h = harness({ failOn: 'bob' });
    const r = await runHeadless(h.deps, state(['alice', 'bob', 'carol']), h.ctl.signal);
    expect(r.stopped).toBe('finished');
    expect(h.minted.map((m) => m.name)).toEqual(['alice', 'carol']);
    expect(h.listed.map((l) => l.name)).toEqual(['alice', 'carol']);
    expect(r.state.items[1]).toMatchObject({ status: 'error', txids: [] });
    expect(r.state.items[1].note).toMatch(/covenant check failed locally/);
    const h2 = harness();
    h2.ours.add('alice');
    h2.ours.add('carol');
    const r2 = await runHeadless(h2.deps, mergeState(r.state, [], {}), h2.ctl.signal);
    expect(r2.stopped).toBe('finished');
    expect(h2.minted.map((m) => m.name)).toEqual(['bob']);
  });

  test('ten failures in a row stop the run', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `name${String(i).padStart(2, '0')}`);
    const h = harness({ failOn: names });
    const r = await runHeadless(h.deps, state(names), h.ctl.signal);
    expect(r.stopped).toBe('error');
    expect(r.error).toMatch(/10 names in a row failed/);
    expect(r.state.items.filter((i) => i.status === 'error').length).toBe(10);
  });

  test('a failed listing never stops minting and is retried at the end', async () => {
    const h = harness();
    let fails = 1;
    h.deps.list = async (name, sats) => {
      if (name === 'alice' && fails-- > 0) throw new Error('insufficient funds for listing');
      return h.listed.push({ name, sats }), `${name}-list`;
    };
    const r = await runHeadless(h.deps, state(['alice', 'bobby']), h.ctl.signal);
    expect(r.stopped).toBe('finished');
    expect(r.state.items.map((i) => i.listed)).toEqual([true, true]);
    expect(h.listed.map((l) => l.name)).toEqual(['bobby', 'alice']);
  });

  test('kill switch stops before spending', async () => {
    const h = harness({ stopped: () => true });
    const r = await runHeadless(h.deps, state(['alice']), h.ctl.signal);
    expect(r.stopped).toBe('killed');
    expect(h.minted).toEqual([]);
  });
});

describe('isTransient', () => {
  test('a parent not yet at the provider is retried, a covenant failure is not', () => {
    expect(isTransient('The txid abc parameter must be valid transaction on chain main')).toBe(true);
    expect(isTransient('HttpError: not found')).toBe(true);
    expect(isTransient('502 Bad Gateway')).toBe(true);
    expect(isTransient('The name tree for "jackpot" is still catching up with your last mints.')).toBe(true);
    expect(isTransient('Covenant check failed')).toBe(false);
  });
});

describe('mergeState prune', () => {
  test('pending names not in the new lists leave the job; done ones stay', () => {
    const s = newState('a', buildQueue([['alpha', 'beta', 'gamma']]), { to: '1Owner', budgetSats: 1e9 });
    s.items[0].status = 'done';
    const m = mergeState(s, buildQueue([['beta']]), {}, true);
    expect(m.items.map((i) => `${i.name}:${i.status}`)).toEqual(['beta:pending', 'alpha:done']);
    const kept = mergeState(s, buildQueue([['beta']]), {});
    expect(kept.items.length).toBe(3);
  });
});

describe('buildQueue listsOnly', () => {
  test('vault and gift files route but add nothing', () => {
    const q = buildQueue([['alice', 'bob']], ['bob', 'keepme'], ['gifty'], true);
    expect(q).toEqual([
      { name: 'bob', route: 'vault' },
      { name: 'alice', route: 'sell' },
    ]);
  });
});

describe('BEEF depth limit (14 Oct 2026)', () => {
  test('recognised, and the run waits for the next block', async () => {
    const { isDepthLimit, waitForNextBlock } = await import('./batch.js');
    expect(isDepthLimit('Maximum BEEF depth exceeded. Limit is 12')).toBe(true);
    expect(isDepthLimit('still catching up')).toBe(false);
    let h = 100;
    const f = (async () => new Response(JSON.stringify({ blocks: h }))) as unknown as typeof fetch;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 2) h = 101;
    };
    const ok = await waitForNextBlock(f, sleep, new AbortController().signal, 10 * 60_000, 1000);
    expect(ok).toBe(true);
    expect(slept.length).toBe(2);
  });
});


describe('revisit held names in the same run (14 Oct 2026)', () => {
  test('which errors are worth another go', async () => {
    const { isRevisitable } = await import('./batch.js');
    expect(isRevisitable('The name tree for "laura" is still catching up with your last mints.')).toBe(true);
    expect(isRevisitable('The txid 792e… parameter must be valid transaction on chain main')).toBe(true);
    expect(isRevisitable('covenant check failed at PC 2703')).toBe(false);
  });
});

describe('stale proofs after a reorg (16 Oct 2026: "merged Beef failed validation")', () => {
  const badBeef = () => Object.assign(new Error('merged Beef failed validation.'), { code: 'WERR_INTERNAL' });

  test('the wallet refusing its own BEEF triggers a proof repair, then the same name is retried and minted', async () => {
    let repaired = false;
    const h = harness();
    const realMine = h.deps.mine;
    const r = await runHeadless(
      {
        ...h.deps,
        mine: async (...a) => {
          if (!repaired) throw badBeef();
          return realMine(...a);
        },
        repairProofs: async () => {
          repaired = true;
          return { checked: 96, stale: [{ height: 971225, merkleRoot: '35bc5d' }], updated: 86, unavailable: 0, errors: 0 };
        },
      },
      state(['bignumber', 'bigpop']),
      h.ctl.signal,
    );
    expect(r.stopped).toBe('finished');
    expect(h.minted.map((m) => m.name)).toEqual(['bignumber', 'bigpop']);
  });

  test('nothing repairable: stops at once (not after ten names) with what to do, name left to retry', async () => {
    let tries = 0;
    let repairs = 0;
    const h = harness();
    const r = await runHeadless(
      {
        ...h.deps,
        mine: async () => {
          tries++;
          throw badBeef();
        },
        repairProofs: async () => (repairs++, { checked: 96, stale: [{ height: 971225, merkleRoot: '35bc5d' }], updated: 0, unavailable: 86, errors: 0 }),
      },
      state(['bignumber', 'bigpop']),
      h.ctl.signal,
    );
    expect(r.stopped).toBe('error');
    expect(tries).toBe(1);
    expect(repairs).toBe(1);
    expect(r.error).toMatch(/^bignumber: merged Beef failed validation\./);
    expect(r.error).toMatch(/reorg/);
    expect(r.error).toMatch(/height 971225/);
    expect(r.error).toMatch(/Run the same command again/);
    expect(r.state.items.find((x) => x.name === 'bigpop')?.status).toBe('pending');
  });

  test('without a repair hook the message still says what happened', async () => {
    const h = harness();
    const r = await runHeadless({ ...h.deps, mine: async () => { throw badBeef(); } }, state(['bignumber']), h.ctl.signal);
    expect(r.stopped).toBe('error');
    expect(r.error).toMatch(/orphan|reorg/);
  });
});

describe('tree catching up: wait, then retry the same name', () => {
  test('classifier', () => {
    const yes = [
      'The name tree for "seychelles" is still catching up with your last mints. Wait for them to confirm (about 10 minutes), then try again.',
      'waiting for confirmations',
      'Unconfirmed parent for input 0',
      'parent is still unconfirmed',
      'txn-mempool-conflict: too-long-mempool-chain',
      'too long mempool chain',
    ];
    const no = ['OpNS covenant check failed locally, not broadcast: OP_VERIFY failed', 'Insufficient funds', 'fetch failed', 'Maximum BEEF depth exceeded'];
    for (const m of yes) expect(isTreeWait(m)).toBe(true);
    for (const m of no) expect(isTreeWait(m)).toBe(false);
  });
  test('backoff 2, 4, 8, then capped at 10 min', () => {
    expect([0, 1, 2, 3, 9].map(treeWaitMs)).toEqual([120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const catching = (name: string) => `The name tree for "${name}" is still catching up with your last mints. Wait for them to confirm (about 10 minutes), then try again.`;

  test('five tree waits in a row do not stop the run; the same name is retried and minted', async () => {
    vi.useFakeTimers();
    try {
      let fails = 5;
      const waits: string[] = [];
      const h = harness({ sleep: realSleep, onWait: (l: string) => waits.push(l) });
      const mine = h.deps.mine;
      h.deps.mine = async (...a) => {
        if (fails-- > 0) throw new Error(catching(a[0]));
        return mine(...a);
      };
      const seen: (string | undefined)[] = [];
      h.deps.save = (s) => seen.push(s.waiting ? `${s.waiting.name}@${s.waiting.since}` : undefined);
      const p = runHeadless(h.deps, state(['seychelles', 'zed']), h.ctl.signal);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 4 * 60_000 + 8 * 60_000 + 2 * 10 * 60_000 + 60_000);
      const r = await p;
      expect(r.stopped).toBe('finished');
      expect(h.minted.map((m) => m.name)).toEqual(['seychelles', 'zed']);
      expect(r.state.waiting).toBeUndefined();
      expect(waits[0]).toMatch(/waiting for confirmations… resuming "seychelles" in 02:00/);
      expect(seen.filter(Boolean)[0]).toMatch(/^seychelles@/);
      // the "since" stays the start of the first wait across retries
      expect(new Set(seen.filter(Boolean)).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a name still waiting after an hour is set aside and the run carries on', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ sleep: realSleep });
      const mine = h.deps.mine;
      h.deps.mine = async (...a) => {
        if (a[0] === 'cyprus') throw new Error(catching(a[0]));
        return mine(...a);
      };
      const p = runHeadless(h.deps, state(['cyprus', 'zed']), h.ctl.signal);
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      const r = await p;
      expect(r.stopped).toBe('finished');
      expect(h.minted.map((m) => m.name)).toEqual(['zed']);
      expect(r.state.items[0].status).toBe('error');
      expect(r.state.items[0].note).toMatch(/^Set aside after/);
      expect(r.state.waiting).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('Ctrl-C during a tree wait cancels at once and leaves the name pending', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ sleep: realSleep });
      h.deps.mine = async (name) => {
        throw new Error(catching(name));
      };
      const p = runHeadless(h.deps, state(['seychelles']), h.ctl.signal);
      await vi.advanceTimersByTimeAsync(1500);
      h.ctl.abort();
      const r = await p;
      expect(r.stopped).toBe('cancelled');
      expect(r.state.items[0].status).toBe('pending');
      expect(r.state.waiting).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('real errors still stop after ten in a row', async () => {
    const h = harness({ failOn: Array.from({ length: 12 }, (_, k) => `name${k}`) });
    const r = await runHeadless(h.deps, state(Array.from({ length: 12 }, (_, k) => `name${k}`)), h.ctl.signal);
    expect(r.error).toMatch(/10 names in a row failed/);
  });
});
