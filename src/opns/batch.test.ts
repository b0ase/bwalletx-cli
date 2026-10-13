import { describe, expect, test } from 'vitest';
import {
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
const harness = (o: Partial<RunDeps> & { taken?: string[]; failOn?: string; cancelOn?: string } = {}) => {
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
    if (name === o.failOn) throw new Error('OpNS covenant check failed locally, not broadcast: OP_VERIFY failed');
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

  test('a mint the local covenant check blocks stops the run: nothing after it, no listing, retried next run', async () => {
    const h = harness({ failOn: 'bob' });
    const r = await runHeadless(h.deps, state(['alice', 'bob', 'carol']), h.ctl.signal);
    expect(r.stopped).toBe('error');
    expect(r.error).toMatch(/covenant check failed locally/);
    expect(h.minted.map((m) => m.name)).toEqual(['alice']);
    expect(h.listed.map((l) => l.name)).toEqual(['alice']);
    expect(r.state.items[1]).toMatchObject({ status: 'error', txids: [] });
    const h2 = harness();
    h2.ours.add('alice');
    const r2 = await runHeadless(h2.deps, mergeState(r.state, [], {}), h2.ctl.signal);
    expect(r2.stopped).toBe('finished');
    expect(h2.minted.map((m) => m.name)).toEqual(['bob', 'carol']);
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
    expect(isTransient('Covenant check failed')).toBe(false);
  });
});
