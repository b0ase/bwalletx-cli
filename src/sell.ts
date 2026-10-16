/**
 * Selling and listing from the CLI: `bwalletx list | unlist | listings | buy-listing <outpoint>`.
 *
 * Every spend goes through the account's own BRC-100 wallet (the CLI's wallet-toolbox store, as `opns` uses),
 * with the @1sat/actions builders the bWalletX app uses:
 *   - ordinals:   sellOrdinal / cancelOrdinalListing / buyOrdinal (OrdLock v2)
 *   - OpNS names: sellOpns / cancelOpnsListing (names live in their own basket)
 *   - BSV-21:     sendBsv21 to a listing script (BSV-21 transfer inscription around an OrdLock v2), as the app's
 *                 sell sheet does (bWalletX src/mobile/sell); cancelTokenListing or the recorded cancel key;
 *                 buyBsv21 to buy
 * Purchases add the 1% bWalletX market fee (as `buy <tokenId>` and the app's Market do).
 *
 * --dry-run runs the same builder against a wallet that records the createAction it is asked for and refuses
 * it: the transaction is assembled (inputs, outputs, scripts), nothing is signed, nothing is broadcast.
 * Paired accounts are refused: their keys stay on the phone.
 */
import { join } from 'node:path';
import { BSV21, OrdLock, OrdLockV2 } from '@1sat/templates';
import {
  BSV21_BASKET,
  OPNS_BASKET,
  ORDINALS_BASKET,
  P1SAT_PROTOCOL,
  bsv21FieldsFromOutput,
  bsv21FilterTags,
  buildBsv21CustomInstructions,
  buyBsv21,
  buyOrdinal,
  cancelOpnsListing,
  cancelOrdinalListing,
  cancelTokenListing,
  defaultPayAddress,
  executeTrackedAction,
  prepareP1SatArgs,
  sellOpns,
  sellOrdinal,
  sendBsv21,
  type OneSatContext,
} from '@1sat/actions';
import { LockingScript, P2PKH, PublicKey, Transaction, type CreateActionArgs, type CreateActionOutput, type Script, type WalletInterface, type WalletOutput } from '@bsv/sdk';
import { MARKET_FEE_ADDRESS, MARKET_FEE_RATE, marketFeeSats } from './buy.js';
import { gateAction } from './gate.js';
import { bsvUsd, outpointUnspent, overlayFee } from './market.js';
import { allStopped, appendLog, home, readJsonFile, writeJsonFile } from './store.js';
import { rawTx } from './wallet.js';
import type { AgentLogEntry, ActionRequest } from './strategy.js';

// ---------------------------------------------------------------- pure helpers

/** "txid_vout", "txid.vout" or "txid:vout" → parts and both spellings. Throws on anything else. */
export function parseOutpoint(s: string) {
  const m = /^([0-9a-f]{64})[._:](\d{1,6})$/i.exec(s.trim());
  if (!m) throw new Error(`Not an outpoint: "${s}" (want <txid>_<vout>)`);
  const txid = m[1]!.toLowerCase();
  const vout = Number(m[2]);
  return { txid, vout, us: `${txid}_${vout}`, dot: `${txid}.${vout}` };
}
const sameOutpoint = (a: string, b: string) => a.replace('.', '_').toLowerCase() === b.replace('.', '_').toLowerCase();

/** Cancel key per token: deterministic, so a lost record can still be cancelled (bWalletX sell.ts cancelKeyID). */
export const cancelKeyID = (tokenId: string) => `ordlock-${tokenId.replace('.', '_')}`;

/** The 1Sat BSV-21 listing script: transfer inscription wrapped around an OrdLock v2 (bWalletX sell.ts). */
export function buildListingScript(tokenId: string, amount: bigint, cancelAddress: string, payAddress: string, priceSats: number): LockingScript {
  if (!(priceSats >= 1) || !Number.isInteger(priceSats)) throw new Error('Price must be a whole number of sats (at least 1)');
  if (amount <= 0n) throw new Error('Amount must be positive');
  const ordLock = OrdLockV2.lock(cancelAddress, payAddress, priceSats);
  return BSV21.transfer(tokenId, amount).lock(new LockingScript(ordLock.chunks));
}

export type DecodedListing = { priceSats: number; seller: string; v2: boolean; token: { id: string; amount: bigint } | null };

/** Any 1Sat OrdLock listing (v1 or v2), with its BSV-21 transfer when it lists tokens. null when not a listing. */
export function decodeAnyListing(script: Script): DecodedListing | null {
  const v2 = OrdLockV2.decode(script);
  const lock = v2 ?? OrdLock.decode(script);
  if (!lock) return null;
  const tok = BSV21.decode(script);
  const id = tok?.getTokenId();
  const token = tok && id && tok.getOperation() === 'transfer' ? { id, amount: tok.getAmount() } : null;
  return { priceSats: Number(lock.price), seller: lock.seller, v2: !!v2, token };
}

/** "1.5" at 2 decimals → 150n; null when not a positive amount at that precision. */
export function toRaw(input: string, dec: number): bigint | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > dec) return null;
  const raw = BigInt((whole || '0') + frac.padEnd(dec, '0'));
  return raw > 0n ? raw : null;
}
export function fromRaw(raw: bigint, dec: number): string {
  if (dec <= 0) return raw.toString();
  const s = raw.toString().padStart(dec + 1, '0');
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${s.slice(0, -dec)}.${frac}` : s.slice(0, -dec);
}

// ---------------------------------------------------------------- dry-run wallet

export const DRY_RUN_STOP = 'bwalletx dry run: stopped before signing';
const WRITES = new Set(['createAction', 'signAction', 'internalizeAction', 'relinquishOutput', 'abortAction', 'createSignature']);

/**
 * A wallet that answers reads (listOutputs, getPublicKey, …) from the real one and records the first
 * createAction instead of running it. Every other write is refused. Nothing can be signed or broadcast.
 */
export function dryRunWallet(w: WalletInterface) {
  const captured: CreateActionArgs[] = [];
  const wallet = new Proxy(w, {
    get(t, p, r) {
      if (p === 'createAction')
        return async (args: CreateActionArgs) => {
          captured.push(args);
          throw new Error(DRY_RUN_STOP);
        };
      if (typeof p === 'string' && WRITES.has(p))
        return async () => {
          throw new Error(DRY_RUN_STOP);
        };
      const v = Reflect.get(t, p, r) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { wallet: wallet as WalletInterface, captured };
}

export type BuiltTx = { description: string; inputs: number; outputs: { satoshis: number; description?: string; script: string }[]; outputSats: number };
export const summariseArgs = (a: CreateActionArgs): BuiltTx => ({
  description: a.description,
  inputs: a.inputs?.length ?? 0,
  outputs: (a.outputs ?? []).map((o) => ({ satoshis: o.satoshis, ...(o.outputDescription && { description: o.outputDescription }), script: o.lockingScript.slice(0, 64) + (o.lockingScript.length > 64 ? '…' : '') })),
  outputSats: (a.outputs ?? []).reduce((s, o) => s + o.satoshis, 0),
});

// ---------------------------------------------------------------- wiring (injectable for tests)

type Res = { txid?: string; tx?: number[]; error?: string };
type Exec<I> = { execute: (ctx: OneSatContext, input: I) => Promise<Res> };

export type TokenRecord = { outpoint: string; tokenId: string; amount: string; priceSats: number; keyID: string; sym?: string; dec?: number; createdAt: number };

export type SellAccount = { name: string; ctx: OneSatContext; sendWaiting: () => Promise<void>; close: () => Promise<void> };

export type SellDeps = {
  open: (account?: string) => Promise<SellAccount>;
  fetchTx: (txid: string) => Promise<Transaction>;
  unspent: (outpoint: string) => Promise<boolean>;
  rate: () => Promise<number>;
  overlayFee: (tokenId: string) => Promise<{ address: string; sats: number } | null>;
  gate: (name: string, a: ActionRequest) => { ok: true; paper: boolean } | { ok: false; reason: string };
  stopped: () => boolean;
  log: (name: string, e: AgentLogEntry) => void;
  records: { load: (name: string) => TokenRecord[]; save: (name: string, r: TokenRecord[]) => void };
  actions: {
    sellOrdinal: Exec<{ id: string; price: number }>;
    sellOpns: Exec<{ id: string; price: number }>;
    sendBsv21: Exec<{ tokenId: string; recipients: { amount: string; destination: { lockingScript: string } }[] }>;
    cancelOrdinalListing: Exec<{ id: string }>;
    cancelTokenListing: Exec<{ id: string }>;
    cancelOpnsListing: Exec<{ id: string }>;
    cancelRecorded: Exec<{ record: TokenRecord; listingTx: Transaction }>;
    buyOrdinal: Exec<{ outpoint: string; marketplaceAddress: string; marketplaceRate: number }>;
    buyBsv21: Exec<{ tokenId: string; outpoint: string; amount: string; marketplaceAddress: string; marketplaceRate: number }>;
  };
};

const safe = (s: string) => s.replace(/[^\w.-]/g, '_');
export const recordsPath = (name: string) => join(home(), `listings-${safe(name)}.json`);

/** Cancel a BSV-21 listing this CLI made with sendBsv21 (not tracked in a basket): the recorded cancel key signs. */
const cancelRecorded: SellDeps['actions']['cancelRecorded'] = {
  async execute(ctx, { record, listingTx }) {
    const { txid, vout, dot } = parseOutpoint(record.outpoint);
    const decoded = decodeAnyListing(listingTx.outputs[vout]!.lockingScript);
    if (!decoded?.token) return { error: 'That output is not a token listing' };
    const tokenId = decoded.token.id;
    const amount = decoded.token.amount;
    const backKeyID = `${tokenId}-${Date.now()}`;
    const { publicKey } = await ctx.wallet.getPublicKey({ protocolID: P1SAT_PROTOCOL, keyID: backKeyID, counterparty: 'self', forSelf: true });
    const back = PublicKey.fromString(publicKey).toAddress();
    const outputs: CreateActionOutput[] = [
      {
        lockingScript: BSV21.transfer(tokenId, amount).lock(new P2PKH().lock(back)).toHex(),
        satoshis: 1,
        outputDescription: 'Cancelled listing (tokens back)',
        basket: BSV21_BASKET,
        tags: bsv21FilterTags({ tokenId }),
        customInstructions: buildBsv21CustomInstructions({
          token: { id: tokenId, amt: amount.toString(), op: 'transfer', ...(record.sym && { sym: record.sym }), ...(record.dec != null && { dec: record.dec }) },
          protocolID: P1SAT_PROTOCOL,
          keyID: backKeyID,
          counterparty: 'self',
        }),
      },
    ];
    const ov = await overlayFee(tokenId).catch(() => null);
    if (ov) outputs.push({ lockingScript: new P2PKH().lock(ov.address).toHex(), satoshis: ov.sats, outputDescription: 'Overlay processing fee', tags: ['fee:overlay'] });
    const beef = await ctx.services!.getBeefForTxid(txid);
    const inputBEEF = beef.toBinary();
    const args = await prepareP1SatArgs(ctx, {
      description: 'Cancel token listing',
      inputBEEF,
      inputs: [{ outpoint: dot, inputDescription: 'Listed tokens', unlockingScriptLength: decoded.v2 ? 120 : 108 }],
      outputs,
      options: { randomizeOutputs: false },
    });
    const r = await executeTrackedAction(
      ctx.wallet,
      args,
      undefined,
      inputBEEF,
      async (tx: Transaction) => {
        const idx = tx.inputs.findIndex((i) => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === vout);
        if (idx < 0) throw new Error('Listing input missing from the transaction');
        if (!tx.inputs[idx]!.sourceTransaction) tx.inputs[idx]!.sourceTransaction = listingTx;
        const unlocker = decoded.v2 ? OrdLockV2.cancelWithWallet(ctx.wallet, P1SAT_PROTOCOL, record.keyID, 'self') : OrdLock.cancelWithWallet(ctx.wallet, P1SAT_PROTOCOL, record.keyID, 'self');
        return { [idx]: { unlockingScript: (await unlocker.sign(tx, idx)).toHex() } };
      },
      { spends: [{ outpoint: dot, scheme: 'bsv21' }], permissionScheme: 'bsv21' } as Parameters<typeof executeTrackedAction>[5],
    );
    return r as Res;
  },
};

const defaultDeps = (): SellDeps => ({
  async open(account) {
    const { brc100Account } = await import('./brc100Actions.js');
    const { oneSatServices } = await import('./opns/headless.js');
    const { OneSatServices } = await import('@1sat/client');
    const { name, w } = await brc100Account(account);
    // 1Sat services for token details, overlay checks and submits; BEEF from the toolbox providers (as `opns`).
    const one = new OneSatServices('main') as unknown as Record<string, unknown>;
    const beef = oneSatServices() as unknown as { getBeefForTxid: unknown };
    const services = new Proxy(one, { get: (t, p) => (p === 'getBeefForTxid' ? beef.getBeefForTxid : Reflect.get(t, p)) }) as unknown as OneSatContext['services'];
    const ctx: OneSatContext = { wallet: w.wallet as unknown as WalletInterface, chain: 'main', services, dataDir: home(), isBaseWallet: true };
    return { name, ctx, sendWaiting: () => w.sendWaiting(), close: () => w.close() };
  },
  fetchTx: async (txid) => Transaction.fromHex(await rawTx(txid)),
  unspent: outpointUnspent,
  rate: bsvUsd,
  overlayFee,
  gate: (name, a) => gateAction(name, a),
  stopped: allStopped,
  log: appendLog,
  records: {
    load: (name) => readJsonFile<TokenRecord[]>(recordsPath(name)) ?? [],
    save: (name, r) => writeJsonFile(recordsPath(name), r),
  },
  actions: {
    sellOrdinal: sellOrdinal as never,
    sellOpns: sellOpns as never,
    sendBsv21: sendBsv21 as never,
    cancelOrdinalListing: cancelOrdinalListing as never,
    cancelTokenListing: cancelTokenListing as never,
    cancelOpnsListing: cancelOpnsListing as never,
    cancelRecorded,
    buyOrdinal: buyOrdinal as never,
    buyBsv21: buyBsv21 as never,
  },
});

let depsOverride: Partial<SellDeps> | null = null;
/** Tests: replace any of the network / wallet pieces. `null` restores the real ones. */
export const setSellDeps = (d: Partial<SellDeps> | null) => (depsOverride = d);
const deps = (): SellDeps => ({ ...defaultDeps(), ...(depsOverride ?? {}) }) as SellDeps;

export type SellResult = { ok: boolean; text: string; dryRun?: boolean; txid?: string; outpoint?: string; built?: BuiltTx; sats?: number };
type Confirm = (q: string) => Promise<boolean>;
const fmtUsd = (n: number) => (n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`);

/** Run an action for real, or (dry run) against the recording wallet and return what it built. */
async function runAction<I>(acct: SellAccount, exec: Exec<I>, input: I, dryRun: boolean): Promise<{ res: Res; built?: BuiltTx }> {
  if (!dryRun) return { res: await exec.execute(acct.ctx, input) };
  const dry = dryRunWallet(acct.ctx.wallet);
  const res = await exec.execute({ ...acct.ctx, wallet: dry.wallet }, input).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const args = dry.captured[0];
  if (!args) throw new Error(`Dry run: the builder stopped before a transaction: ${res.error ?? 'no transaction'}`);
  return { res: {}, built: summariseArgs(args) };
}

const txidFromResult = (r: Res, what: string) => {
  if (r.error || !r.txid) throw new Error(`${what} failed: ${r.error ?? 'not broadcast'}`);
  return r.txid;
};

type Owned =
  | { kind: 'ordinal' | 'opns'; output: WalletOutput; id: string; listed: boolean; token: null }
  | { kind: 'token'; output: WalletOutput; id: string; listed: boolean; token: { id: string; amt: bigint; sym?: string; dec: number } };

const idOf = (o: WalletOutput) => o.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o.outpoint;
const isListed = (o: WalletOutput) => !!o.tags?.some((t) => t.startsWith('ordlock'));

/** Find an outpoint among the wallet's ordinals, OpNS names and BSV-21 tokens. */
async function findOwned(ctx: OneSatContext, outpoint: string): Promise<Owned | null> {
  for (const basket of [ORDINALS_BASKET, OPNS_BASKET, BSV21_BASKET]) {
    const r = await ctx.wallet.listOutputs({ basket, includeTags: true, includeCustomInstructions: true, limit: 10_000 }, 'bwalletx-cli');
    const o = r.outputs.find((x) => sameOutpoint(x.outpoint, outpoint));
    if (!o) continue;
    const f = bsv21FieldsFromOutput(o);
    if (basket === BSV21_BASKET || (basket === ORDINALS_BASKET && f.tokenId && f.amt)) {
      if (!f.tokenId || !f.amt) throw new Error('That token output has no token id/amount in the wallet');
      return { kind: 'token', output: o, id: idOf(o), listed: isListed(o), token: { id: f.tokenId, amt: BigInt(f.amt), ...(f.sym && { sym: f.sym }), dec: Number(f.dec ?? 0) } };
    }
    return { kind: basket === OPNS_BASKET ? 'opns' : 'ordinal', output: o, id: idOf(o), listed: isListed(o), token: null };
  }
  return null;
}

const refuseSpend = (d: SellDeps, name: string, a: ActionRequest): string | null => {
  const g = d.gate(name, a);
  if (!g.ok) return `Refused: ${g.reason}`;
  if (g.paper) return 'Paper mode: nothing is signed (load the strategy --live, or unload it)';
  return null;
};

// ---------------------------------------------------------------- list

export type ListOpts = { account?: string; outpoint: string; priceSats: number; amount?: string; dryRun?: boolean; confirm?: Confirm };

/** List an ordinal, an OpNS name, or BSV-21 tokens (a token output in the wallet) on the 1Sat order book. */
export async function listForSale(o: ListOpts): Promise<SellResult> {
  const d = deps();
  const op = parseOutpoint(o.outpoint);
  if (!(Number.isInteger(o.priceSats) && o.priceSats >= 1)) throw new Error('--price is a whole number of sats, at least 1');
  if (!o.dryRun && d.stopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
  const acct = await d.open(o.account);
  try {
    const own = await findOwned(acct.ctx, op.dot);
    if (!own) return { ok: false, text: `${op.us} is not in ${acct.name}'s wallet (ordinals, OpNS names or BSV-21 tokens)` };
    if (own.listed) return { ok: false, text: `${op.us} is already listed (bwalletx unlist ${op.us})` };
    const rate = await d.rate().catch(() => 0);
    const priceText = `${o.priceSats.toLocaleString()} sats${rate ? ` (≈ ${fmtUsd((o.priceSats / 1e8) * rate)})` : ''}`;

    let what: string;
    let run: () => Promise<{ res: Res; built?: BuiltTx }>;
    let record: Omit<TokenRecord, 'outpoint' | 'createdAt'> | null = null;
    if (own.kind === 'token') {
      const t = own.token;
      const raw = o.amount ? toRaw(o.amount, t.dec) : t.amt;
      if (raw === null) throw new Error(`--amount must be a positive number with at most ${t.dec} decimals`);
      if (raw > t.amt) throw new Error(`That output holds ${fromRaw(t.amt, t.dec)} ${t.sym ?? 'tokens'}; can't list ${fromRaw(raw, t.dec)}`);
      const keyID = cancelKeyID(t.id);
      const { publicKey } = await acct.ctx.wallet.getPublicKey({ protocolID: P1SAT_PROTOCOL, keyID, counterparty: 'self', forSelf: true });
      const cancel = PublicKey.fromString(publicKey).toAddress();
      const pay = await defaultPayAddress(acct.ctx);
      const script = buildListingScript(t.id, raw, cancel, pay, o.priceSats);
      const back = decodeAnyListing(script);
      if (!back?.token || back.token.id !== t.id || back.token.amount !== raw || back.priceSats !== o.priceSats) throw new Error('Listing script failed its round-trip check');
      what = `${fromRaw(raw, t.dec)} ${t.sym ?? t.id}`;
      record = { tokenId: t.id, amount: raw.toString(), priceSats: o.priceSats, keyID, ...(t.sym && { sym: t.sym }), dec: t.dec };
      run = () => runAction(acct, d.actions.sendBsv21, { tokenId: t.id, recipients: [{ amount: raw.toString(), destination: { lockingScript: script.toHex() } }] }, !!o.dryRun);
    } else {
      what = own.kind === 'opns' ? `OpNS name ${op.us}` : `ordinal ${op.us}`;
      const exec = own.kind === 'opns' ? d.actions.sellOpns : d.actions.sellOrdinal;
      run = () => runAction(acct, exec, { id: own.id, price: o.priceSats }, !!o.dryRun);
    }

    if (o.dryRun) {
      const { built } = await run();
      return { ok: true, dryRun: true, built, text: `Dry run: list ${what} for ${priceText} from ${acct.name}. Built a ${built!.inputs}-input, ${built!.outputs.length}-output listing (OrdLock v2); nothing signed, nothing broadcast.` };
    }
    const refused = refuseSpend(d, acct.name, { kind: 'list', token: own.token?.id ?? (own.kind === 'opns' ? 'opns' : 'ordinal'), ...(own.token?.sym && { ticker: own.token.sym }), usd: 0 });
    if (refused) return { ok: false, text: refused };
    if (o.confirm && !(await o.confirm(`List ${what} for ${priceText} from ${acct.name}? Anyone can buy it at that price until you unlist it.`))) return { ok: false, text: 'Not confirmed (pass --yes to skip)' };
    const { res } = await run();
    const txid = txidFromResult(res, 'Listing');
    await acct.sendWaiting();
    let outpoint = `${txid}_0`;
    if (record) {
      const vout = res.tx ? listingVout(res.tx, record.tokenId) : 0;
      outpoint = `${txid}_${vout}`;
      d.records.save(acct.name, [{ ...record, outpoint, createdAt: Date.now() }, ...d.records.load(acct.name).filter((r) => !sameOutpoint(r.outpoint, outpoint))]);
    }
    const text = `Listed ${what} for ${priceText}: ${outpoint}`;
    d.log(acct.name, { at: Date.now(), action: 'list', detail: text, usd: 0, txid });
    return { ok: true, text, txid, outpoint };
  } finally {
    await acct.close();
  }
}

function listingVout(tx: number[], tokenId: string): number {
  let parsed: Transaction;
  try {
    parsed = Transaction.fromAtomicBEEF(tx);
  } catch {
    try {
      parsed = Transaction.fromBinary(tx);
    } catch {
      return 0;
    }
  }
  const i = parsed.outputs.findIndex((x) => decodeAnyListing(x.lockingScript)?.token?.id === tokenId);
  return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------- unlist

export type UnlistOpts = { account?: string; outpoint: string; dryRun?: boolean; confirm?: Confirm };

/** Cancel one of the account's listings; the item returns to its wallet. */
export async function unlist(o: UnlistOpts): Promise<SellResult> {
  const d = deps();
  const op = parseOutpoint(o.outpoint);
  if (!o.dryRun && d.stopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
  const acct = await d.open(o.account);
  try {
    const own = await findOwned(acct.ctx, op.dot);
    const rec = d.records.load(acct.name).find((r) => sameOutpoint(r.outpoint, op.us));
    let what: string;
    let run: () => Promise<{ res: Res; built?: BuiltTx }>;
    if (own?.listed) {
      what = own.kind === 'token' ? `${fromRaw(own.token.amt, own.token.dec)} ${own.token.sym ?? own.token.id}` : `${own.kind === 'opns' ? 'OpNS name' : 'ordinal'} ${op.us}`;
      const exec = own.kind === 'token' ? d.actions.cancelTokenListing : own.kind === 'opns' ? d.actions.cancelOpnsListing : d.actions.cancelOrdinalListing;
      run = () => runAction(acct, exec, { id: own.id }, !!o.dryRun);
    } else if (rec) {
      if (!(await d.unspent(op.us))) return { ok: false, text: `${op.us} is no longer listed (sold or cancelled)` };
      const listingTx = await d.fetchTx(op.txid);
      what = `${rec.sym ? fromRaw(BigInt(rec.amount), rec.dec ?? 0) + ' ' + rec.sym : rec.amount + ' of ' + rec.tokenId}`;
      run = () => runAction(acct, d.actions.cancelRecorded, { record: rec, listingTx }, !!o.dryRun);
    } else {
      return { ok: false, text: `${op.us} is not one of ${acct.name}'s listings (see bwalletx listings)` };
    }
    if (o.dryRun) {
      const { built } = await run();
      return { ok: true, dryRun: true, built, text: `Dry run: unlist ${what} (${op.us}) from ${acct.name}. Built the cancel (${built!.inputs} input(s), ${built!.outputs.length} output(s)); nothing signed, nothing broadcast.` };
    }
    // A cancel only pays the network (and overlay) fee: gated as a $0 list action (kill switch, rate limit).
    const refused = refuseSpend(d, acct.name, { kind: 'list', token: own?.token?.id ?? rec?.tokenId ?? 'ordinal', usd: 0 });
    if (refused) return { ok: false, text: refused };
    if (o.confirm && !(await o.confirm(`Cancel the listing of ${what} (${op.us}) and return it to ${acct.name}?`))) return { ok: false, text: 'Not confirmed (pass --yes to skip)' };
    const { res } = await run();
    const txid = txidFromResult(res, 'Cancel');
    await acct.sendWaiting();
    if (rec) d.records.save(acct.name, d.records.load(acct.name).filter((r) => !sameOutpoint(r.outpoint, op.us)));
    const text = `Unlisted ${what} (${op.us})`;
    d.log(acct.name, { at: Date.now(), action: 'list-cancel', detail: text, usd: 0, txid });
    return { ok: true, text, txid, outpoint: op.us };
  } finally {
    await acct.close();
  }
}

// ---------------------------------------------------------------- listings

export type MyListing = { outpoint: string; kind: 'ordinal' | 'opns' | 'token'; priceSats: number | null; priceUsd: number | null; token?: { id: string; amount: string; sym?: string }; name?: string; status: 'live' | 'gone' | 'unknown' };

/** The account's open listings: OrdLock outputs in its wallet plus BSV-21 listings this CLI recorded. */
export async function myListings(account?: string): Promise<{ account: string; listings: MyListing[] }> {
  const d = deps();
  const acct = await d.open(account);
  try {
    const rate = await d.rate().catch(() => 0);
    const usdOf = (s: number | null) => (s != null && rate ? (s / 1e8) * rate : null);
    const out: MyListing[] = [];
    for (const basket of [ORDINALS_BASKET, OPNS_BASKET]) {
      const r = await acct.ctx.wallet.listOutputs({ basket, includeTags: true, includeCustomInstructions: true, limit: 10_000 }, 'bwalletx-cli');
      for (const x of r.outputs.filter(isListed)) {
        const priceTag = x.tags?.find((t) => t.startsWith('price:'))?.slice(6);
        const price = priceTag && /^\d+$/.test(priceTag) ? Number(priceTag) : null;
        const f = bsv21FieldsFromOutput(x);
        let name: string | undefined = x.tags?.find((t) => t.startsWith('name:'))?.slice(5);
        try {
          name ??= (JSON.parse(x.customInstructions ?? '') as { name?: string }).name;
        } catch {
          /* no name */
        }
        out.push({
          outpoint: x.outpoint.replace('.', '_'),
          kind: f.tokenId && f.amt ? 'token' : basket === OPNS_BASKET ? 'opns' : 'ordinal',
          priceSats: price,
          priceUsd: usdOf(price),
          ...(f.tokenId && f.amt && { token: { id: f.tokenId, amount: f.amt, ...(f.sym && { sym: f.sym }) } }),
          ...(name && { name }),
          status: 'unknown',
        });
      }
    }
    for (const rec of d.records.load(acct.name)) {
      if (out.some((x) => sameOutpoint(x.outpoint, rec.outpoint))) continue;
      out.push({ outpoint: rec.outpoint, kind: 'token', priceSats: rec.priceSats, priceUsd: usdOf(rec.priceSats), token: { id: rec.tokenId, amount: rec.amount, ...(rec.sym && { sym: rec.sym }) }, status: 'unknown' });
    }
    await Promise.all(
      out.map(async (x) => {
        x.status = await d.unspent(x.outpoint).then(
          (u) => (u ? 'live' : 'gone'),
          () => 'unknown' as const,
        );
      }),
    );
    return { account: acct.name, listings: out };
  } finally {
    await acct.close();
  }
}

// ---------------------------------------------------------------- buy a listing by outpoint

export type BuyListingOpts = { account?: string; outpoint: string; dryRun?: boolean; confirm?: Confirm; maxUsd?: number };

/** Buy one 1Sat listing (an ordinal or a BSV-21 listing) by its outpoint. Seller price + 1% market fee. */
export async function buyListing(o: BuyListingOpts): Promise<SellResult> {
  const d = deps();
  const op = parseOutpoint(o.outpoint);
  if (!o.dryRun && d.stopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
  const tx = await d.fetchTx(op.txid);
  const out = tx.outputs[op.vout];
  if (!out) return { ok: false, text: `${op.us}: no such output` };
  const l = decodeAnyListing(out.lockingScript);
  if (!l) return { ok: false, text: `${op.us} is not a 1Sat OrdLock listing` };
  if (!(await d.unspent(op.us))) return { ok: false, text: `${op.us} was already bought or cancelled` };
  const fee = marketFeeSats(l.priceSats);
  const ov = l.token ? await d.overlayFee(l.token.id).catch(() => null) : null;
  const sats = l.priceSats + fee + (ov?.sats ?? 0);
  const rate = await d.rate();
  const usd = (sats / 1e8) * rate;
  if (o.maxUsd != null && usd > o.maxUsd + 1e-9) return { ok: false, text: `${op.us} costs ${fmtUsd(usd)} with fees, over --max-usd ${fmtUsd(o.maxUsd)}` };
  const what = l.token ? `${l.token.amount} units of ${l.token.id}` : `ordinal ${op.us}`;
  const breakdown = `${l.priceSats.toLocaleString()} sats to seller + ${fee} market fee${ov ? ` + ${ov.sats} overlay fee` : ''} + network fee`;

  const acct = await d.open(o.account);
  try {
    const run = (dry: boolean) =>
      l.token
        ? runAction(acct, d.actions.buyBsv21, { tokenId: l.token.id, outpoint: op.us, amount: l.token.amount.toString(), marketplaceAddress: MARKET_FEE_ADDRESS, marketplaceRate: MARKET_FEE_RATE }, dry)
        : runAction(acct, d.actions.buyOrdinal, { outpoint: op.us, marketplaceAddress: MARKET_FEE_ADDRESS, marketplaceRate: MARKET_FEE_RATE }, dry);
    if (o.dryRun) {
      const { built } = await run(true);
      return { ok: true, dryRun: true, built, sats, outpoint: op.us, text: `Dry run: buy ${what} (OrdLock ${l.v2 ? 'v2' : 'v1'}) for ≈ ${fmtUsd(usd)}: ${breakdown}. Built the purchase (${built!.inputs} input(s), ${built!.outputs.length} output(s)); nothing signed, nothing broadcast.` };
    }
    const refused = refuseSpend(d, acct.name, { kind: 'buy', token: l.token?.id ?? 'ordinal', usd, ...(l.token && { amount: Number(l.token.amount) }) });
    if (refused) return { ok: false, text: refused };
    if (o.confirm && !(await o.confirm(`Buy ${what} for ≈ ${fmtUsd(usd)} (${breakdown}) from ${acct.name}?`))) return { ok: false, text: 'Not confirmed (pass --yes to skip)' };
    if (!(await d.unspent(op.us))) return { ok: false, text: `${op.us} was just bought or cancelled` };
    const { res } = await run(false);
    const txid = txidFromResult(res, 'Purchase');
    await acct.sendWaiting();
    const text = `Bought ${what} for ≈ ${fmtUsd(usd)} (${sats} sats + network fee)`;
    d.log(acct.name, { at: Date.now(), action: 'buy', detail: `${text} ${op.us}`, usd, txid });
    return { ok: true, text, txid, outpoint: op.us, sats };
  } finally {
    await acct.close();
  }
}
