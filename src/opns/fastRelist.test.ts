import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Beef, LockingScript, P2PKH, PrivateKey, PublicKey, Transaction } from '@bsv/sdk';
import { OrdLockV2, ORDLOCK_V2_CANCEL_UNLOCK_LENGTH } from '@1sat/templates';
import { P1SAT_PROTOCOL } from '@1sat/types';
import { describe, expect, test } from 'vitest';
import { buildFastRelistArgs, decodeListing, fastRelist, MAX_FAST_BATCH, type FastRelistItem } from './fastRelist.js';
import { loadRelistProgress, remaining, saveRelistProgress, type RelistItem } from './opnsOutputs.js';

const addr = () => PrivateKey.fromRandom().toPublicKey().toAddress();
const seller = addr();
const payee = addr();

/** A source tx whose output 0 is an OrdLock v2 listing of `name` at `price`. */
const listingFor = (name: string, price: number, n = 0) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: OrdLockV2.lock(seller, payee, price), satoshis: 1 });
  tx.addOutput({ lockingScript: new P2PKH().lock(seller), satoshis: 1000 + n }); // unique txid
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const txid = tx.id('hex');
  return {
    listing: {
      outpoint: `${txid}.0`,
      tags: ['opns', 'origin:' + 'ab'.repeat(32) + '_0', 'type:application/op-ns', 'ordlock2', `price:${price}`, `id:act${n}_0`],
      customInstructions: JSON.stringify({ protocolID: [1, '1sat'], keyID: `${'cd'.repeat(32)}.${n}`, counterparty: 'self', name }),
    },
    beef: beef.toBinary(),
  };
};

const item = (name: string, oldPrice: number, newPrice: number, n = 0): FastRelistItem => ({
  ...listingFor(name, oldPrice, n),
  cancelAddress: addr(),
  payAddress: payee,
  price: newPrice,
});

describe('decodeListing', () => {
  test('reads price, seller and P2PKH pay address back', () => {
    expect(decodeListing(OrdLockV2.lock(seller, payee, 12345))).toEqual({ seller, price: 12345, payAddress: payee });
    expect(decodeListing(new P2PKH().lock(seller))).toBeNull();
  });
});

describe('buildFastRelistArgs', () => {
  test('one name: cancel input → new listing at the new price, same payee, sellOpns tags', () => {
    const it = item('paris', 900_000, 1_234_567);
    const { args, spends } = buildFastRelistArgs([it]);
    expect(args.inputs).toEqual([{ outpoint: it.listing.outpoint, inputDescription: 'Listed OpNS name (relist)', unlockingScriptLength: ORDLOCK_V2_CANCEL_UNLOCK_LENGTH }]);
    expect(args.outputs).toHaveLength(1);
    const out = args.outputs![0];
    expect(out.satoshis).toBe(1);
    expect(out.basket).toBe('opns');
    expect(out.tags).toEqual(['opns', 'origin:' + 'ab'.repeat(32) + '_0', 'type:application/op-ns', 'ordlock2', 'price:1234567']);
    const ci = JSON.parse(out.customInstructions!);
    expect(ci).toMatchObject({ keyID: it.listing.outpoint, counterparty: 'self', name: 'paris' });
    // Script level: decode the new output back.
    const d = decodeListing(LockingScript.fromHex(out.lockingScript));
    expect(d).toEqual({ seller: it.cancelAddress, price: 1_234_567, payAddress: payee });
    expect(spends).toEqual([{ basket: 'opns', id: 'act0_0' }]);
    expect(args.labels).toHaveLength(1);
    expect(args.options).toEqual({ randomizeOutputs: false });
    expect(args.description).toBe('Relist OpNS paris');
    // inputBEEF carries the listing tx.
    const txid = it.listing.outpoint.split('.')[0];
    expect(Beef.fromBinary(args.inputBEEF as number[]).findTxid(txid)).toBeTruthy();
  });

  test('N names: input i ↔ output i, each with its own price, one merged BEEF', () => {
    const items = [item('aa', 1, 500, 1), item('bbb', 2, 600, 2), item('cccc', 3, 700, 3)];
    const { args, spends } = buildFastRelistArgs(items);
    expect(args.inputs!.map((x) => x.outpoint)).toEqual(items.map((x) => x.listing.outpoint));
    expect(args.outputs!.map((o) => decodeListing(LockingScript.fromHex(o.lockingScript))!.price)).toEqual([500, 600, 700]);
    expect(args.outputs!.map((o) => JSON.parse(o.customInstructions!).name)).toEqual(['aa', 'bbb', 'cccc']);
    expect(args.outputs!.map((o) => o.tags!.find((t) => t.startsWith('price:')))).toEqual(['price:500', 'price:600', 'price:700']);
    expect(spends.map((s) => s.id)).toEqual(['act1_0', 'act2_0', 'act3_0']);
    const beef = Beef.fromBinary(args.inputBEEF as number[]);
    for (const it of items) expect(beef.findTxid(it.listing.outpoint.split('.')[0])).toBeTruthy();
    expect(args.description).toBe('Relist 3 OpNS names');
  });

  test('refuses bad input', () => {
    expect(() => buildFastRelistArgs([])).toThrow();
    expect(() => buildFastRelistArgs(Array.from({ length: MAX_FAST_BATCH + 1 }, (_, i) => item('x', 1, 2, i)))).toThrow(/at most/);
    expect(() => buildFastRelistArgs([{ ...item('x', 1, 2), price: 0 }])).toThrow(/price/);
    const noId = item('x', 1, 2);
    noId.listing.tags = noId.listing.tags.filter((t) => !t.startsWith('id:'));
    expect(() => buildFastRelistArgs([noId])).toThrow(/id:/);
  });
});

describe('fastRelist (fake wallet, no signing)', () => {
  test('loads each listing, keeps its pay address, derives cancel key from its outpoint, sends one tx', async () => {
    const rows = [listingFor('lima', 10, 7), listingFor('oslo', 20, 8)];
    const keyIds: string[] = [];
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const wallet = {
      listOutputs: async (a: { tags: string[] }) => {
        const r = rows.find((x) => x.listing.tags.includes(a.tags[0]))!;
        return { totalOutputs: 1, outputs: [r.listing], BEEF: r.beef };
      },
      getPublicKey: async (a: { keyID: string }) => (keyIds.push(a.keyID), { publicKey: key }),
    };
    let sent: { args: { outputs: { lockingScript: string }[]; inputs: { outpoint: string }[] }; opts: unknown } | undefined;
    const r = await fastRelist({ wallet } as never, [{ id: 'act7_0', price: 111 }, { id: 'act8_0', price: 222 }], {
      exec: (async (_w: unknown, args: never, _f: unknown, _b: unknown, _s: unknown, opts: unknown) => ((sent = { args, opts }), { txid: 'f'.repeat(64) })) as never,
    });
    expect(r.txid).toBe('f'.repeat(64));
    expect(keyIds).toEqual(rows.map((x) => x.listing.outpoint));
    expect(sent!.args.inputs.map((i) => i.outpoint)).toEqual(rows.map((x) => x.listing.outpoint));
    const outs = sent!.args.outputs.map((o) => decodeListing(LockingScript.fromHex(o.lockingScript))!);
    expect(outs.map((o) => [o.price, o.payAddress])).toEqual([[111, payee], [222, payee]]);
    expect(outs.map((o) => o.seller)).toEqual([PublicKey.fromString(key).toAddress(), PublicKey.fromString(key).toAddress()]);
    expect(sent!.opts).toMatchObject({ spends: [{ basket: 'opns', id: 'act7_0' }, { basket: 'opns', id: 'act8_0' }], permissionScheme: 'opns' });
  });

  test('exec error propagates', async () => {
    const row = listingFor('rome', 10, 9);
    const wallet = {
      listOutputs: async () => ({ totalOutputs: 1, outputs: [row.listing], BEEF: row.beef }),
      getPublicKey: async () => ({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() }),
    };
    await expect(fastRelist({ wallet } as never, [{ id: 'act9_0', price: 5 }], { exec: (async () => ({ error: 'boom' })) as never })).rejects.toThrow('boom');
  });
});

describe('fast relist resume', () => {
  test('names done by a fast tx (shared txid) are skipped on the next run', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fast-')), 'p.json');
    const p = loadRelistProgress(path, 'acc');
    const items: RelistItem[] = ['a', 'b', 'c'].map((name) => ({ name, id: name, outpoint: `${name}.0`, oldSats: 1, newSats: 2, newUsd: 10 }));
    for (const n of ['a', 'b']) p.done[n] = { txid: 'e'.repeat(64), at: 1, sats: 2 };
    saveRelistProgress(path, p);
    expect(remaining(items, loadRelistProgress(path, 'acc')).map((x) => x.name)).toEqual(['c']);
  });
});

describe('script check: the cancel branch can be spent straight into a new listing', () => {
  test('wallet-signed cancel of listing → new OrdLock output verifies', async () => {
    const { ProtoWallet } = await import('@bsv/sdk');
    const { unlockByScript } = await import('@1sat/actions');
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const keyID = `${'cd'.repeat(32)}.0`;
    const { publicKey } = await wallet.getPublicKey({ protocolID: P1SAT_PROTOCOL, keyID, forSelf: true });
    const sellerAddr = PublicKey.fromString(publicKey).toAddress();
    const src = new Transaction();
    src.addOutput({ lockingScript: OrdLockV2.lock(sellerAddr, payee, 1000), satoshis: 1 });
    const it: FastRelistItem = {
      listing: { outpoint: `${src.id('hex')}.0`, tags: ['opns', 'ordlock2', 'id:x_0'], customInstructions: JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID, counterparty: 'self', name: 'zz' }) },
      beef: (() => { const b = new Beef(); b.mergeTransaction(src); return b.toBinary(); })(),
      cancelAddress: addr(),
      payAddress: payee,
      price: 4242,
    };
    const { args } = buildFastRelistArgs([it]);
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff });
    tx.addOutput({ lockingScript: LockingScript.fromHex(args.outputs![0].lockingScript), satoshis: 1 });
    const u = await unlockByScript(wallet as never, tx, 0, src.outputs[0].lockingScript, 1, { protocolID: P1SAT_PROTOCOL, keyID, counterparty: 'self' } as never);
    expect('unlockingScript' in u).toBe(true);
    tx.inputs[0].unlockingScript = (await import('@bsv/sdk')).UnlockingScript.fromHex((u as { unlockingScript: string }).unlockingScript);
    expect(OrdLockV2.isCancel(tx.inputs[0].unlockingScript)).toBe(true);
    const { Spend } = await import('@bsv/sdk');
    const spend = new Spend({
      sourceTXID: src.id('hex'), sourceOutputIndex: 0, sourceSatoshis: 1, lockingScript: src.outputs[0].lockingScript,
      transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, inputIndex: 0,
      unlockingScript: tx.inputs[0].unlockingScript, inputSequence: 0xffffffff, lockTime: tx.lockTime,
    });
    expect(spend.validate()).toBe(true);
    expect(decodeListing(tx.outputs[0].lockingScript)).toEqual({ seller: it.cancelAddress, price: 4242, payAddress: payee });
  });
});
