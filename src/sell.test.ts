import { afterEach, describe, expect, test, vi } from 'vitest';
import { OrdLockV2 } from '@1sat/templates';
import { BSV21_BASKET, OPNS_BASKET, ORDINALS_BASKET, buildBsv21CustomInstructions } from '@1sat/actions';
import { P2PKH, PrivateKey, Transaction, type CreateActionArgs, type WalletOutput } from '@bsv/sdk';
import {
  buildListingScript,
  buyListing,
  cancelKeyID,
  decodeAnyListing,
  dryRunWallet,
  DRY_RUN_STOP,
  fromRaw,
  listForSale,
  myListings,
  parseOutpoint,
  setSellDeps,
  toRaw,
  unlist,
  type SellDeps,
  type TokenRecord,
} from './sell';
import { MARKET_FEE_ADDRESS, MARKET_FEE_RATE } from './buy';

const TXID = 'cd'.repeat(32);
const TOKEN = `${'ab'.repeat(32)}_0`;
const key = PrivateKey.fromRandom();
const addr = () => PrivateKey.fromRandom().toAddress();

describe('pure helpers', () => {
  test('parseOutpoint takes _ . and : forms', () => {
    for (const s of [`${TXID}_3`, `${TXID}.3`, `${TXID}:3`]) expect(parseOutpoint(s)).toMatchObject({ txid: TXID, vout: 3, us: `${TXID}_3`, dot: `${TXID}.3` });
    expect(() => parseOutpoint('nope')).toThrow(/Not an outpoint/);
  });

  test('BSV-21 listing script round-trips (transfer inscription around OrdLock v2)', () => {
    const s = buildListingScript(TOKEN, 5000n, addr(), addr(), 12_345);
    expect(decodeAnyListing(s)).toMatchObject({ priceSats: 12_345, v2: true, token: { id: TOKEN, amount: 5000n } });
    expect(() => buildListingScript(TOKEN, 1n, addr(), addr(), 0)).toThrow(/whole number/);
    expect(() => buildListingScript(TOKEN, 0n, addr(), addr(), 10)).toThrow(/positive/);
  });

  test('an ordinal listing decodes with no token', () => {
    expect(decodeAnyListing(OrdLockV2.lock(addr(), addr(), 777))).toMatchObject({ priceSats: 777, token: null });
    expect(decodeAnyListing(new P2PKH().lock(addr()))).toBeNull();
  });

  test('amounts', () => {
    expect(toRaw('1.5', 2)).toBe(150n);
    expect(toRaw('1.555', 2)).toBeNull();
    expect(toRaw('0', 2)).toBeNull();
    expect(fromRaw(150n, 2)).toBe('1.5');
    expect(cancelKeyID(`${'ab'.repeat(32)}.0`)).toBe(`ordlock-${TOKEN}`);
  });

  test('dryRunWallet records createAction, refuses writes, passes reads', async () => {
    const real = { createAction: vi.fn(), signAction: vi.fn(), getPublicKey: vi.fn(async () => ({ publicKey: 'pk' })) };
    const d = dryRunWallet(real as never);
    await expect(d.wallet.createAction({ description: 'x', outputs: [] })).rejects.toThrow(DRY_RUN_STOP);
    await expect(d.wallet.signAction({ reference: 'r', spends: {} })).rejects.toThrow(DRY_RUN_STOP);
    expect(await d.wallet.getPublicKey({ identityKey: true })).toEqual({ publicKey: 'pk' });
    expect(d.captured).toHaveLength(1);
    expect(real.createAction).not.toHaveBeenCalled();
    expect(real.signAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- flows against a fake wallet and mocked network

type Baskets = Partial<Record<string, WalletOutput[]>>;
const out = (outpoint: string, tags: string[] = [], customInstructions?: string): WalletOutput => ({ outpoint, satoshis: 1, spendable: true, tags, ...(customInstructions && { customInstructions }) }) as WalletOutput;

function fakeWallet(baskets: Baskets) {
  return {
    listOutputs: vi.fn(async (a: { basket: string }) => ({ totalOutputs: (baskets[a.basket] ?? []).length, outputs: baskets[a.basket] ?? [] })),
    getPublicKey: vi.fn(async () => ({ publicKey: key.toPublicKey().toString() })),
    createAction: vi.fn(async () => ({ txid: 'f'.repeat(64) })),
    signAction: vi.fn(),
  };
}

/** A stand-in action: builds a createAction like the real builders do and returns what the wallet gives back. */
const builder = (shape: (input: Record<string, unknown>) => CreateActionArgs) =>
  vi.fn(async (ctx: { wallet: { createAction: (a: CreateActionArgs) => Promise<{ txid?: string }> } }, input: Record<string, unknown>) => {
    try {
      const r = await ctx.wallet.createAction(shape(input));
      return { txid: r.txid };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });

function setup(baskets: Baskets, over: Partial<SellDeps> = {}) {
  const wallet = fakeWallet(baskets);
  let records: TokenRecord[] = [];
  const calls = {
    gate: vi.fn((): { ok: true; paper: boolean } | { ok: false; reason: string } => ({ ok: true, paper: false })),
    log: vi.fn(),
    sendWaiting: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const simple = builder(() => ({ description: 'stub', inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'in', unlockingScriptLength: 108 }], outputs: [{ lockingScript: '00', satoshis: 1, outputDescription: 'out' }] }));
  const actions = {
    sellOrdinal: { execute: simple },
    sellOpns: { execute: simple },
    sendBsv21: {
      execute: builder((i) => ({
        description: 'Send tokens',
        outputs: (i.recipients as { destination: { lockingScript: string } }[]).map((r) => ({ lockingScript: r.destination.lockingScript, satoshis: 1, outputDescription: 'listing' })),
      })),
    },
    cancelOrdinalListing: { execute: simple },
    cancelTokenListing: { execute: simple },
    cancelOpnsListing: { execute: simple },
    cancelRecorded: { execute: simple },
    buyOrdinal: { execute: simple },
    buyBsv21: { execute: simple },
  };
  setSellDeps({
    open: async () => ({ name: 'agent', ctx: { wallet: wallet as never, chain: 'main', isBaseWallet: true }, sendWaiting: calls.sendWaiting, close: calls.close }),
    unspent: async () => true,
    rate: async () => 50,
    overlayFee: async () => ({ address: addr(), sats: 1000 }),
    gate: calls.gate,
    stopped: () => false,
    log: calls.log,
    records: { load: () => records, save: (_n, r) => void (records = r) },
    actions: actions as never,
    ...over,
  });
  return { wallet, calls, actions, records: () => records };
}

afterEach(() => setSellDeps(null));

const tokenOut = (outpoint: string, amt = '5000') => out(outpoint, [`bsv21:${TOKEN}`, 'id:tok1'], buildBsv21CustomInstructions({ token: { id: TOKEN, amt, sym: 'TEST', dec: 2 } }));

describe('list', () => {
  test('dry run (BSV-21): builds the OrdLock v2 listing through sendBsv21, signs nothing, gates nothing', async () => {
    const t = setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] });
    const r = await listForSale({ outpoint: `${TXID}_1`, priceSats: 25_000, amount: '10', dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(r.text).toMatch(/10 TEST for 25,000 sats/);
    expect(t.wallet.createAction).not.toHaveBeenCalled();
    expect(t.calls.gate).not.toHaveBeenCalled();
    expect(t.records()).toEqual([]);
    expect(t.actions.sendBsv21.execute).toHaveBeenCalledOnce();
    const sent = t.actions.sendBsv21.execute.mock.calls[0]![1] as { tokenId: string; recipients: { amount: string; destination: { lockingScript: string } }[] };
    expect(sent.tokenId).toBe(TOKEN);
    expect(sent.recipients[0]!.amount).toBe('1000');
    const { LockingScript } = await import('@bsv/sdk');
    expect(decodeAnyListing(LockingScript.fromHex(sent.recipients[0]!.destination.lockingScript))).toMatchObject({ priceSats: 25_000, token: { id: TOKEN, amount: 1000n } });
    expect(t.calls.close).toHaveBeenCalled();
  });

  test('live (BSV-21) with --yes: gated as list, broadcasts, records the cancel key, logs', async () => {
    const t = setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] });
    const r = await listForSale({ outpoint: `${TXID}_1`, priceSats: 25_000 });
    expect(r.ok).toBe(true);
    expect(t.calls.gate).toHaveBeenCalledWith('agent', expect.objectContaining({ kind: 'list', token: TOKEN, usd: 0 }));
    expect(t.wallet.createAction).toHaveBeenCalledOnce();
    expect(t.records()).toEqual([expect.objectContaining({ tokenId: TOKEN, amount: '5000', priceSats: 25_000, keyID: cancelKeyID(TOKEN) })]);
    expect(t.calls.log).toHaveBeenCalledWith('agent', expect.objectContaining({ action: 'list' }));
  });

  test('declined confirmation sends nothing', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])] });
    const r = await listForSale({ outpoint: `${TXID}_0`, priceSats: 1000, confirm: async () => false });
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/Not confirmed/) });
    expect(t.actions.sellOrdinal.execute).not.toHaveBeenCalled();
  });

  test('ordinals use sellOrdinal with the basket id; OpNS names use sellOpns', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])], [OPNS_BASKET]: [out(`${TXID}.2`, ['id:n1', 'name:bob'])] });
    await listForSale({ outpoint: `${TXID}_0`, priceSats: 1000, dryRun: true });
    expect(t.actions.sellOrdinal.execute.mock.calls[0]![1]).toEqual({ id: 'o1', price: 1000 });
    await listForSale({ outpoint: `${TXID}_2`, priceSats: 2000, dryRun: true });
    expect(t.actions.sellOpns.execute.mock.lastCall![1]).toEqual({ id: 'n1', price: 2000 });
  });

  test('refusals: paper mode, not owned, already listed, too many tokens', async () => {
    setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])] }, { gate: () => ({ ok: true, paper: true }) });
    expect((await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 })).text).toMatch(/Paper mode/);
    setup({});
    expect((await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 })).text).toMatch(/not in agent's wallet/);
    setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1', 'ordlock:v2'])] });
    expect((await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 })).text).toMatch(/already listed/);
    setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] });
    await expect(listForSale({ outpoint: `${TXID}_1`, priceSats: 1, amount: '51', dryRun: true })).rejects.toThrow(/holds 50 TEST/);
  });
});

describe('unlist', () => {
  test('dry run on a wallet listing builds the cancel only', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1', 'ordlock:v2'])] });
    const r = await unlist({ outpoint: `${TXID}_0`, dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(t.actions.cancelOrdinalListing.execute.mock.calls[0]![1]).toEqual({ id: 'o1' });
    expect(t.wallet.createAction).not.toHaveBeenCalled();
  });

  test('a recorded BSV-21 listing is cancelled with its key and forgotten', async () => {
    const listingTx = new Transaction();
    listingTx.addOutput({ lockingScript: buildListingScript(TOKEN, 10n, addr(), addr(), 500), satoshis: 1 });
    const rec: TokenRecord = { outpoint: `${TXID}_0`, tokenId: TOKEN, amount: '10', priceSats: 500, keyID: cancelKeyID(TOKEN), createdAt: 1 };
    const save = vi.fn();
    const t = setup({}, { fetchTx: async () => listingTx, records: { load: () => [rec], save } });
    const r = await unlist({ outpoint: `${TXID}.0` });
    expect(r.ok).toBe(true);
    expect(t.actions.cancelRecorded.execute.mock.calls[0]![1]).toMatchObject({ record: rec, listingTx });
    expect(save).toHaveBeenCalledWith('agent', []);
  });

  test('not ours', async () => {
    setup({});
    expect((await unlist({ outpoint: `${TXID}_0` })).text).toMatch(/not one of agent's listings/);
  });
});

describe('buy-listing <outpoint>', () => {
  const ordinalListing = () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: OrdLockV2.lock(addr(), addr(), 100_000), satoshis: 1 });
    return tx;
  };

  test('dry run (ordinal): buyOrdinal with the 1% market fee, nothing signed', async () => {
    const t = setup({}, { fetchTx: async () => ordinalListing() });
    const r = await buyListing({ outpoint: `${TXID}_0`, dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, sats: 101_000 });
    expect(r.text).toMatch(/100,000 sats to seller \+ 1000 market fee/);
    expect(t.actions.buyOrdinal.execute.mock.calls[0]![1]).toEqual({ outpoint: `${TXID}_0`, marketplaceAddress: MARKET_FEE_ADDRESS, marketplaceRate: MARKET_FEE_RATE });
    expect(t.wallet.createAction).not.toHaveBeenCalled();
    expect(t.calls.gate).not.toHaveBeenCalled();
  });

  test('live (BSV-21): gated as a buy with the full cost, buyBsv21 with the listed amount', async () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: buildListingScript(TOKEN, 42n, addr(), addr(), 10_000), satoshis: 1 });
    const t = setup({}, { fetchTx: async () => tx });
    const r = await buyListing({ outpoint: `${TXID}_0`, confirm: async () => true });
    expect(r.ok).toBe(true);
    expect(t.actions.buyBsv21.execute.mock.calls[0]![1]).toMatchObject({ tokenId: TOKEN, amount: '42', marketplaceAddress: MARKET_FEE_ADDRESS });
    const usd = ((10_000 + 100 + 1000) / 1e8) * 50;
    expect(t.calls.gate).toHaveBeenCalledWith('agent', expect.objectContaining({ kind: 'buy', token: TOKEN, usd }));
    expect(t.calls.log).toHaveBeenCalledWith('agent', expect.objectContaining({ action: 'buy', usd }));
  });

  test('refusals: spent, not a listing, over --max-usd, kill switch, gate', async () => {
    setup({}, { fetchTx: async () => ordinalListing(), unspent: async () => false });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/already bought or cancelled/);
    const p2pkh = new Transaction();
    p2pkh.addOutput({ lockingScript: new P2PKH().lock(addr()), satoshis: 5 });
    setup({}, { fetchTx: async () => p2pkh });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/not a 1Sat OrdLock listing/);
    setup({}, { fetchTx: async () => ordinalListing() });
    expect((await buyListing({ outpoint: `${TXID}_0`, maxUsd: 0.01 })).text).toMatch(/over --max-usd/);
    setup({}, { fetchTx: async () => ordinalListing(), stopped: () => true });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/stopped/);
    const t = setup({}, { fetchTx: async () => ordinalListing(), gate: () => ({ ok: false, reason: 'Over today' }) });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/Refused: Over today/);
    expect(t.actions.buyOrdinal.execute).not.toHaveBeenCalled();
  });
});

describe('listings', () => {
  test('wallet OrdLock outputs + recorded BSV-21 listings, with live status', async () => {
    const rec: TokenRecord = { outpoint: `${'ee'.repeat(32)}_0`, tokenId: TOKEN, amount: '10', priceSats: 500, keyID: 'k', sym: 'TEST', createdAt: 1 };
    setup(
      { [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1', 'ordlock:v2', 'price:777']), out(`${TXID}.1`, ['id:o2'])], [OPNS_BASKET]: [out(`${TXID}.2`, ['ordlock:v2', 'price:5000', 'name:bob'])] },
      { records: { load: () => [rec], save: vi.fn() }, unspent: async (o) => !o.startsWith('ee') },
    );
    const r = await myListings();
    expect(r.listings).toEqual([
      expect.objectContaining({ outpoint: `${TXID}_0`, kind: 'ordinal', priceSats: 777, status: 'live' }),
      expect.objectContaining({ outpoint: `${TXID}_2`, kind: 'opns', priceSats: 5000, name: 'bob', status: 'live' }),
      expect.objectContaining({ outpoint: rec.outpoint, kind: 'token', priceSats: 500, status: 'gone' }),
    ]);
  });
});
