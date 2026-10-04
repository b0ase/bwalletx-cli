import { describe, expect, test } from 'vitest';
import { BSV21, ORDLOCK_PREFIX, ORDLOCK_SUFFIX } from '@1sat/templates';
import { LockingScript, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { buildPurchase, decodeListing, marketFeeSats, MARKET_FEE_ADDRESS, verifyPurchase } from './buy';

const TOKEN = `${'ab'.repeat(32)}_0`;

/** A v1 OrdLock listing (inscription + PREFIX <cancel pkh> <payout output> SUFFIX), built by hand: the templates disable lock(). */
function makeListing(seller: PrivateKey, priceSats: number, amt: bigint) {
  const payScript = new P2PKH().lock(seller.toAddress()).toBinary();
  const w = new Utils.Writer();
  w.writeUInt64LE(priceSats);
  w.writeVarIntNum(payScript.length);
  w.write(payScript);
  const bin = [...ORDLOCK_PREFIX, ...new Script().writeBin(seller.toPublicKey().toHash() as number[]).writeBin(w.toArray()).toBinary(), ...ORDLOCK_SUFFIX];
  const lock = BSV21.transfer(TOKEN, amt).lock(LockingScript.fromBinary(bin));
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(seller.toAddress()), satoshis: 5 }); // listing at vout 1
  tx.addOutput({ lockingScript: lock, satoshis: 1 });
  return tx;
}

function fundingTx(addr: string, sats: number) {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 1 }); // an ordinal: must not be spent
  return tx;
}

describe('live BSV-21 purchase (synthetic listing, throwaway keys)', () => {
  const seller = PrivateKey.fromRandom();
  const pay = PrivateKey.fromRandom();
  const ord = PrivateKey.fromRandom();
  const price = 123_456;
  const listing = makeListing(seller, price, 5000n);
  const fund = fundingTx(pay.toAddress(), 500_000);
  const overlayFee = { address: PrivateKey.fromRandom().toAddress(), sats: 1000 };
  const o3 = (tx: Transaction) => tx.outputs[3].satoshis;
  const exp = { tokenId: TOKEN, buyerOrdAddress: ord.toAddress(), payAddress: pay.toAddress() };

  test('decodes the listing', () => {
    const d = decodeListing(listing, 1, TOKEN);
    expect(d.amount).toBe(5000n);
    expect(d.payout.satoshis).toBe(price);
    expect(d.seller).toBe(seller.toAddress());
  });

  test('builds a tx that verifies, pays seller + fee, delivers tokens, returns change', async () => {
    const tx = await buildPurchase({
      listingTx: listing,
      listingVout: 1,
      tokenId: TOKEN,
      buyerOrdAddress: ord.toAddress(),
      payWif: pay.toWif(),
      funding: [{ tx: fund, vout: 1 }, { tx: fund, vout: 0 }],
      overlayFee,
    });
    expect(tx.inputs).toHaveLength(2); // the 1-sat coin was skipped
    expect(verifyPurchase(tx, { ...exp, overlayFee }).networkFee).toBeGreaterThan(0);
    expect(o3(tx)).toBe(1000);
    const o = tx.outputs;
    expect(o[0].satoshis).toBe(1);
    expect(o[0].lockingScript.toHex()).toBe(BSV21.transfer(TOKEN, 5000n).lock(new P2PKH().lock(ord.toAddress())).toHex());
    expect(o[1].satoshis).toBe(price);
    expect(o[1].lockingScript.toHex()).toBe(new P2PKH().lock(seller.toAddress()).toHex());
    expect(o[2].satoshis).toBe(marketFeeSats(price));
    expect(o[2].satoshis).toBe(1235);
    expect(o[2].lockingScript.toHex()).toBe(new P2PKH().lock(MARKET_FEE_ADDRESS).toHex());
    expect(o[4].lockingScript.toHex()).toBe(new P2PKH().lock(pay.toAddress()).toHex());
    expect(o[4].satoshis).toBeGreaterThan(500_000 - price - 1235 - 1000 - 1000);
  }, 20_000);

  test('verifyPurchase passes on a good tx (no overlay fee)', async () => {
    const tx = await buildPurchase({ listingTx: listing, listingVout: 1, tokenId: TOKEN, buyerOrdAddress: ord.toAddress(), payWif: pay.toWif(), funding: [{ tx: fund, vout: 0 }] });
    const v = verifyPurchase(tx, exp);
    expect(v.payoutSats).toBe(price);
    expect(v.marketFeeSats).toBe(1235);
    expect(v.networkFee).toBeGreaterThan(0);
    expect(v.networkFee).toBeLessThan(1000);
    expect(tx.outputs).toHaveLength(4);
  }, 20_000);

  test('a tampered seller payout is refused', async () => {
    const tx = await buildPurchase({ listingTx: listing, listingVout: 1, tokenId: TOKEN, buyerOrdAddress: ord.toAddress(), payWif: pay.toWif(), funding: [{ tx: fund, vout: 0 }] });
    tx.outputs[1].satoshis = price - 1;
    expect(() => verifyPurchase(tx, exp)).toThrow();
    // re-signed with the tampered payout, the OrdLock contract itself rejects it
    for (const i of tx.inputs) i.unlockingScript = undefined;
    tx.outputs[3].satoshis = (tx.outputs[3].satoshis ?? 0) + 1;
    await tx.sign();
    expect(() => verifyPurchase(tx, exp)).toThrow(/OrdLock purchase|payout/);
  }, 20_000);

  test('a payout to a different address is refused', async () => {
    const tx = await buildPurchase({ listingTx: listing, listingVout: 1, tokenId: TOKEN, buyerOrdAddress: ord.toAddress(), payWif: pay.toWif(), funding: [{ tx: fund, vout: 0 }] });
    tx.outputs[1].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    for (const i of tx.inputs) i.unlockingScript = undefined;
    await tx.sign();
    expect(() => verifyPurchase(tx, exp)).toThrow(/OrdLock purchase/);
  }, 20_000);

  test('tokens to the wrong address are refused', async () => {
    const tx = await buildPurchase({ listingTx: listing, listingVout: 1, tokenId: TOKEN, buyerOrdAddress: PrivateKey.fromRandom().toAddress(), payWif: pay.toWif(), funding: [{ tx: fund, vout: 0 }] });
    expect(() => verifyPurchase(tx, exp)).toThrow(/Token output/);
  }, 20_000);

  test('not enough BSV', async () => {
    await expect(
      buildPurchase({ listingTx: listing, listingVout: 1, tokenId: TOKEN, buyerOrdAddress: ord.toAddress(), payWif: pay.toWif(), funding: [{ tx: fundingTx(pay.toAddress(), 1000), vout: 0 }] }),
    ).rejects.toThrow(/Not enough BSV/);
  });
});
