/**
 * `opns relist --fast`: move a listing to a new price in ONE transaction. Each old OrdLock v2 listing is spent
 * through its cancel (owner) branch and, in the same tx, a new OrdLock v2 listing of the same ordinal is created
 * at the new price, paid to the same address. Fee/change come from the wallet (createAction funds it).
 *
 * The args are built exactly like @1sat/actions sellOpns / cancelOpnsListing build theirs (same basket, tags,
 * customInstructions, cancel-key derivation, unlocking length), and signing goes through the same
 * executeTrackedAction pipeline: for an OrdLock v2 input with key customInstructions the pipeline signs the
 * cancel branch with OrdLockV2.cancelWithWallet (SIGHASH_ALL|ANYONECANPAY), so several listings can share a tx.
 */
import { Beef, P2PKH, Utils, type CreateActionArgs, type CreateActionOutput, type WalletInterface } from '@bsv/sdk';
import {
  buildOrdinalCustomInstructions,
  buildOrdLockScript,
  defaultPayAddress,
  deriveCancelAddressInternal,
  executeTrackedAction,
  loadBasketOutputBeef,
  ordinalSeedTags,
  type OneSatContext,
} from '@1sat/actions';
import { ORDLOCK_CANCEL_UNLOCK_LENGTH, ORDLOCK_V2_CANCEL_UNLOCK_LENGTH, OrdLockV2 } from '@1sat/templates';
import { buildInputAssetLabel, OPNS_BASKET, ORDLOCK_V2_TAG, P1SAT_PROTOCOL, readAssetIdTag } from '@1sat/types';

/** Most listings per tx. Each adds ~180 B in + ~110 B out; 25 keeps a tx ~8 kB and the BEEF manageable. */
export const MAX_FAST_BATCH = 25;

export type ListingRow = { outpoint: string; tags?: string[]; customInstructions?: string };
export type FastRelistItem = {
  /** the listing as loaded from the opns basket (plaintext customInstructions) */
  listing: ListingRow;
  /** BEEF that contains the listing's source tx */
  beef: number[];
  /** address that can cancel the NEW listing (P1SAT keyID = the spent listing outpoint, self) */
  cancelAddress: string;
  payAddress: string;
  price: number;
};

const dotted = (op: string) => (op.length >= 66 && op[64] === '_' ? `${op.slice(0, 64)}.${op.slice(65)}` : op);

/** The listing's locking script, out of its BEEF. */
export const listingScript = (beef: number[], outpoint: string) => {
  const [txid, vout] = dotted(outpoint).split('.');
  return Beef.fromBinary(beef).findTxid(txid)?.tx?.outputs[Number(vout)]?.lockingScript;
};

/** Decode an OrdLock v2 listing script: cancel (seller) address, price and pay address (P2PKH payout only). */
export const decodeListing = (script: Parameters<typeof OrdLockV2.decode>[0]) => {
  const d = OrdLockV2.decode(script);
  if (!d) return null;
  const r = new Utils.Reader(d.payout);
  r.readUInt64LEBn();
  const s = r.read(r.readVarIntNum());
  const p2pkh = s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac;
  return { seller: d.seller, price: Number(d.price), payAddress: p2pkh ? Utils.toBase58Check(s.slice(3, 23), [0]) : null };
};

const nameOf = (o: ListingRow) => {
  const t = o.tags?.find((x) => x.startsWith('name:'))?.slice(5);
  if (t) return t.slice(0, 64);
  try {
    const n = (JSON.parse(o.customInstructions ?? '') as { name?: unknown }).name;
    return typeof n === 'string' && n ? n.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
};

/** sellOpns's tags: ordinal seed tags + 'opns' + ordlock2 + price:<sats read back from the script>. */
export const listingTags = (listing: ListingRow, price: number) => {
  const tags = ordinalSeedTags(listing as never);
  if (!tags.includes('opns')) tags.unshift('opns');
  for (const e of [ORDLOCK_V2_TAG, `price:${price}`]) if (!tags.includes(e)) tags.push(e);
  return tags;
};

/**
 * createAction args for N relists: input i spends listing i (cancel branch), output i is its new listing.
 * Wallet funding inputs and change are appended after these by createAction (randomizeOutputs: false).
 */
export const buildFastRelistArgs = (items: FastRelistItem[]) => {
  if (!items.length) throw new Error('nothing to relist');
  if (items.length > MAX_FAST_BATCH) throw new Error(`at most ${MAX_FAST_BATCH} names per tx`);
  const beef = new Beef();
  const labels: string[] = [];
  const spends: { basket: string; id: string }[] = [];
  const inputs: NonNullable<CreateActionArgs['inputs']> = [];
  const outputs: CreateActionOutput[] = [];
  for (const it of items) {
    if (!(it.price > 0) || !Number.isInteger(it.price)) throw new Error(`invalid price ${it.price}`);
    if (!it.listing.customInstructions) throw new Error(`missing-custom-instructions ${it.listing.outpoint}`);
    const outpoint = dotted(it.listing.outpoint);
    const old = listingScript(it.beef, outpoint);
    if (!old) throw new Error(`listing ${outpoint} not in its BEEF`);
    beef.mergeBeef(it.beef);
    const script = buildOrdLockScript(it.cancelAddress, it.payAddress, it.price);
    const enc = OrdLockV2.decode(script);
    if (!enc || Number(enc.price) !== it.price) throw new Error('built OrdLock v2 script failed to decode');
    const tags = listingTags(it.listing, Number(enc.price));
    const id = readAssetIdTag(it.listing.tags);
    if (id) {
      labels.push(buildInputAssetLabel(OPNS_BASKET, id));
      spends.push({ basket: OPNS_BASKET, id });
    }
    inputs.push({
      outpoint,
      inputDescription: 'Listed OpNS name (relist)',
      unlockingScriptLength: OrdLockV2.isOrdLockV2(old) ? ORDLOCK_V2_CANCEL_UNLOCK_LENGTH : ORDLOCK_CANCEL_UNLOCK_LENGTH,
    });
    outputs.push({
      lockingScript: script.toHex(),
      satoshis: 1,
      outputDescription: `List OpNS for ${it.price} sats`,
      basket: OPNS_BASKET,
      tags,
      customInstructions: buildOrdinalCustomInstructions({ protocolID: P1SAT_PROTOCOL, keyID: outpoint, counterparty: 'self', tags, name: nameOf(it.listing) }),
    });
  }
  if (spends.length !== items.length) throw new Error('every listing needs an id: tag to be signed');
  const first = nameOf(items[0].listing);
  const args: CreateActionArgs = {
    description: (items.length === 1 ? `Relist OpNS ${first ?? ''}`.trim() : `Relist ${items.length} OpNS names`).slice(0, 50),
    inputBEEF: beef.toBinary(),
    labels,
    inputs,
    outputs,
    options: { randomizeOutputs: false },
  };
  return { args, spends };
};

type Exec = typeof executeTrackedAction;

/**
 * Relist N names in one tx. `ids` are the listing ids (planRelist's `id`), prices in sats. `payFallback` is used
 * only when the old listing's payout is not a plain P2PKH (otherwise the old pay address is kept).
 */
export async function fastRelist(
  ctx: OneSatContext,
  want: { id: string; price: number }[],
  o: { payFallback?: string; exec?: Exec } = {},
): Promise<{ txid: string; items: { id: string; outpoint: string; price: number; payAddress: string }[] }> {
  const items: FastRelistItem[] = [];
  for (const w of want) {
    const loaded = await loadBasketOutputBeef(ctx.wallet as WalletInterface, OPNS_BASKET, w.id);
    if ('error' in loaded) throw new Error(`${w.id}: ${loaded.error}`);
    const listing = loaded.output as ListingRow;
    const script = listingScript(loaded.beef, listing.outpoint);
    const dec = script ? decodeListing(script) : null;
    if (!dec) throw new Error(`${w.id}: not an OrdLock v2 listing (use relist without --fast)`);
    const payAddress = dec.payAddress ?? o.payFallback ?? (await defaultPayAddress(ctx));
    const cancelAddress = await deriveCancelAddressInternal(ctx, dotted(listing.outpoint));
    items.push({ listing, beef: loaded.beef, cancelAddress, payAddress, price: w.price });
  }
  const { args, spends } = buildFastRelistArgs(items);
  const r = (await (o.exec ?? executeTrackedAction)(ctx.wallet as WalletInterface, args, undefined, args.inputBEEF as number[], undefined, {
    spends,
    permissionScheme: 'opns',
  })) as { txid?: string; error?: string };
  if (r.error || !r.txid) throw new Error(String(r.error ?? 'relist failed'));
  return { txid: r.txid, items: items.map((it, i) => ({ id: want[i].id, outpoint: it.listing.outpoint, price: it.price, payAddress: it.payAddress })) };
}

/** P2PKH address check used by tests and callers. */
export const p2pkhHex = (address: string) => new P2PKH().lock(address).toHex();
