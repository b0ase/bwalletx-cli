/**
 * Live BSV-21 purchase of a 1Sat OrdLock (v1) listing, replicating @1sat/actions `buyBsv21`:
 *   input 0   the listing, unlocked by the OrdLock purchase path (no signature; the contract checks outputs)
 *   inputs 1+ P2PKH funding from the account's pay key
 *   output 0  1-sat BSV-21 transfer inscription of the listed amount to the buyer's ord address
 *   output 1  the seller payout, byte-for-byte as encoded in the lock
 *   output 2  bWalletX marketplace fee (1%, ceil) to the bCorp fee address
 *   output 3  overlay processing fee, when the token's 1Sat overlay is active (as the app does)
 *   last      change to the pay address
 * Nothing is broadcast unless verifyPurchase passes: every input's script is executed locally (Spend).
 */
import { BSV21, OrdLock, OrdLockV2 } from '@1sat/templates';
import { LockingScript, P2PKH, PrivateKey, SatoshisPerKilobyte, Spend, Transaction, Utils } from '@bsv/sdk';

/** bCorp fee address (public receive address) and rate: same as the app's Market tab (src/mobile/market/fee.ts). */
export const MARKET_FEE_ADDRESS = '192nuX6cz81MH3T2gwsam3FxYoDrvzDYpU';
export const MARKET_FEE_RATE = 0.01;
export const marketFeeSats = (payoutSats: number, rate = MARKET_FEE_RATE) => Math.ceil(payoutSats * rate);

export type Funding = { tx: Transaction; vout: number };
export type OverlayFee = { address: string; sats: number } | null;

export type PurchaseInput = {
  listingTx: Transaction;
  listingVout: number;
  tokenId: string;
  buyerOrdAddress: string;
  payWif: string;
  /** Candidate funding coins (largest first is best); only as many as needed are used. */
  funding: Funding[];
  feeAddress?: string;
  feeRate?: number;
  overlayFee?: OverlayFee;
  satsPerKb?: number;
};

export type Payout = { satoshis: number; script: LockingScript; raw: number[] };

/** Decode the listing output: v1 OrdLock + BSV-21 transfer inscription of `tokenId`. Throws on anything else. */
export function decodeListing(listingTx: Transaction, vout: number, tokenId: string) {
  const out = listingTx.outputs[vout];
  if (!out) throw new Error('Listing output not found');
  if (OrdLockV2.decode(out.lockingScript)) throw new Error('OrdLock v2 listings are not supported by the CLI yet; buy it in the app');
  const lock = OrdLock.decode(out.lockingScript);
  if (!lock) throw new Error('Not an OrdLock listing');
  const tok = BSV21.decode(out.lockingScript);
  if (!tok || tok.tokenData.op !== 'transfer' || tok.tokenData.id !== tokenId) throw new Error('Listing is not a BSV-21 transfer of this token');
  const amount = BigInt(tok.tokenData.amt as unknown as string);
  const r = new Utils.Reader(lock.payout);
  const satoshis = r.readUInt64LEBn().toNumber();
  const len = r.readVarIntNum();
  const script = LockingScript.fromBinary(r.read(len));
  if (r.pos !== lock.payout.length) throw new Error('Malformed payout in lock');
  return { amount, seller: lock.seller, payout: { satoshis, script, raw: lock.payout } as Payout, listingSats: out.satoshis ?? 1 };
}

export async function buildPurchase(p: PurchaseInput): Promise<Transaction> {
  const { amount, payout } = decodeListing(p.listingTx, p.listingVout, p.tokenId);
  const key = PrivateKey.fromWif(p.payWif);
  const payAddress = key.toAddress();
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: p.listingTx, sourceOutputIndex: p.listingVout, unlockingScriptTemplate: OrdLock.purchaseListing() });
  tx.addOutput({ lockingScript: BSV21.transfer(p.tokenId, amount).lock(new P2PKH().lock(p.buyerOrdAddress)), satoshis: 1 });
  tx.addOutput({ lockingScript: payout.script, satoshis: payout.satoshis });
  const feeAddr = p.feeAddress ?? MARKET_FEE_ADDRESS;
  const fee = feeAddr ? marketFeeSats(payout.satoshis, p.feeRate) : 0;
  if (fee > 0) tx.addOutput({ lockingScript: new P2PKH().lock(feeAddr), satoshis: fee });
  if (p.overlayFee && p.overlayFee.sats > 0) tx.addOutput({ lockingScript: new P2PKH().lock(p.overlayFee.address), satoshis: p.overlayFee.sats });
  const need = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0) - 1; // the listing brings its 1 sat
  let have = 0;
  for (const f of p.funding) {
    if (have >= need + 1000 + tx.inputs.length * 50) break;
    const sats = f.tx.outputs[f.vout]?.satoshis ?? 0;
    if (sats <= 1) continue; // never spend 1-sat ordinals/tokens as fee money
    tx.addInput({ sourceTransaction: f.tx, sourceOutputIndex: f.vout, unlockingScriptTemplate: new P2PKH().unlock(key) });
    have += sats;
  }
  if (have < need) throw new Error(`Not enough BSV: have ${have} sats, need ${need} + network fee`);
  tx.addOutput({ lockingScript: new P2PKH().lock(payAddress), change: true });
  await tx.fee(new SatoshisPerKilobyte(p.satsPerKb ?? 100));
  await tx.sign();
  return tx;
}

export type Expect = {
  tokenId: string;
  buyerOrdAddress: string;
  payAddress: string;
  feeAddress?: string;
  feeRate?: number;
  overlayFee?: OverlayFee;
  /** Upper bound on the network fee in sats (default 50,000). */
  maxNetworkFee?: number;
};

/**
 * Independent checks before broadcast. Throws with the reason on any failure:
 * - every input's unlocking script executes against its source output (Spend)
 * - output 1 equals the payout encoded in the listing lock, byte for byte
 * - output 0 is a 1-sat transfer of exactly the listed amount to the buyer's ord address
 * - the market fee / overlay fee are exact; the only other output is change to the pay address
 */
export function verifyPurchase(tx: Transaction, e: Expect) {
  const listingIn = tx.inputs[0];
  if (!listingIn?.sourceTransaction) throw new Error('Input 0 must be the listing with its source tx');
  const { amount, payout } = decodeListing(listingIn.sourceTransaction, listingIn.sourceOutputIndex, e.tokenId);

  let inSats = 0;
  tx.inputs.forEach((input, i) => {
    const src = input.sourceTransaction;
    if (!src) throw new Error(`Input ${i}: missing source transaction`);
    if (src.id('hex') !== input.sourceTXID && input.sourceTXID) throw new Error(`Input ${i}: source tx mismatch`);
    const out = src.outputs[input.sourceOutputIndex];
    if (!out || !input.unlockingScript) throw new Error(`Input ${i}: missing source output or unlocking script`);
    inSats += out.satoshis ?? 0;
    const spend = new Spend({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: out.satoshis ?? 0,
      lockingScript: out.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      outputs: tx.outputs,
      inputIndex: i,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    });
    let ok = false;
    try {
      ok = spend.validate();
    } catch (err) {
      throw new Error(`Input ${i}${i === 0 ? ' (OrdLock purchase)' : ''} script failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!ok) throw new Error(`Input ${i}${i === 0 ? ' (OrdLock purchase)' : ''} script failed`);
  });

  const outs = tx.outputs;
  const outBytes = (i: number) => {
    const o = outs[i];
    const w = new Utils.Writer();
    w.writeUInt64LE(o.satoshis ?? -1);
    const s = o.lockingScript.toBinary();
    w.writeVarIntNum(s.length);
    w.write(s);
    return Utils.toHex(w.toArray());
  };
  if (!outs[1] || outBytes(1) !== Utils.toHex(payout.raw)) throw new Error('Seller payout output does not match the listing lock');

  const want0 = BSV21.transfer(e.tokenId, amount).lock(new P2PKH().lock(e.buyerOrdAddress)).toHex();
  if (outs[0]?.satoshis !== 1 || outs[0].lockingScript.toHex() !== want0) throw new Error('Token output is not a 1-sat transfer of the listed amount to the buyer ord address');

  let k = 2;
  const feeAddr = e.feeAddress ?? MARKET_FEE_ADDRESS;
  const fee = feeAddr ? marketFeeSats(payout.satoshis, e.feeRate) : 0;
  if (fee > 0) {
    if (outs[k]?.satoshis !== fee || outs[k].lockingScript.toHex() !== new P2PKH().lock(feeAddr).toHex()) throw new Error('Market fee output wrong');
    k++;
  }
  if (e.overlayFee && e.overlayFee.sats > 0) {
    if (outs[k]?.satoshis !== e.overlayFee.sats || outs[k].lockingScript.toHex() !== new P2PKH().lock(e.overlayFee.address).toHex()) throw new Error('Overlay fee output wrong');
    k++;
  }
  const changeScript = new P2PKH().lock(e.payAddress).toHex();
  for (; k < outs.length; k++) if (outs[k].lockingScript.toHex() !== changeScript) throw new Error(`Unexpected output ${k}`);
  const outSats = outs.reduce((s, o) => s + (o.satoshis ?? 0), 0);
  const networkFee = inSats - outSats;
  if (networkFee < 0) throw new Error('Outputs exceed inputs');
  if (networkFee > (e.maxNetworkFee ?? 50_000)) throw new Error(`Network fee ${networkFee} sats is too high`);
  return { amount, payoutSats: payout.satoshis, marketFeeSats: fee, networkFee, totalSats: payout.satoshis + fee + (e.overlayFee?.sats ?? 0) + networkFee };
}
