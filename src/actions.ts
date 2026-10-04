/** Operations shared by the CLI, `agent run` and the MCP server. Every spend goes through gateAction. */
import { readFileSync } from 'node:fs';
import { decryptKeyFile, validateKeyFile, type AgentKeys } from './keyfile.js';
import { bsvBalanceSats, bsvUsd, listings, normTokenId, outpointUnspent, overlayFee, overlayValid, pickListing, submitOverlay, tokenBalances, tokenPrice, TOKEN_ID } from './market.js';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { buildPurchase, marketFeeSats, verifyPurchase } from './buy.js';
import { getPassphrase } from './passphrase.js';
import { gateAction } from './gate.js';
import { callPhone } from './paired.js';

// ---- paired accounts: the phone holds the keys and runs its own checks (paired.ts) ----
type PhoneBalance = { bsv: { sats: number; usd: number | null }; tokens: { id: string; sym?: string; amount: string; dec?: number }[]; paper: unknown };
const phoneDo = async (name: string, action: string, params: unknown): Promise<{ ok: boolean; text: string; txid?: string }> => {
  if (allStopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
  try {
    const r = await callPhone<{ text: string; txid: string | null }>(name, action, params);
    if (r.txid) appendLog(name, { at: Date.now(), action, detail: r.text, usd: 0, txid: r.txid });
    return { ok: true, text: r.text, ...(r.txid && { txid: r.txid }) };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
};
import { parseStrategy, type Loaded, type PaperBook, type AgentLogEntry } from './strategy.js';
import {
  allStopped,
  appendLog,
  getLoaded,
  getPaper,
  readConfig,
  readKeyFile,
  readLog,
  resolveAccount,
  saveKeyFile,
  setLoaded,
  setPaper,
  writeConfig,
  type AccountConfig,
} from './store.js';
import { addressOf, broadcast, buildSend, notifyP2p, rawTx, resolveDestination, utxos, DEFAULT_SATS_PER_KB } from './wallet.js';

export async function importKey(file: string, passphrase?: string) {
  const parsed = validateKeyFile(JSON.parse(readFileSync(file, 'utf8')));
  const keys = await decryptKeyFile(parsed, passphrase ?? (await getPassphrase(`Passphrase for ${parsed.name}: `)));
  const c = readConfig();
  const prev = c.accounts[parsed.name];
  if (prev && prev.identityAddress !== parsed.identityAddress) throw new Error(`An account named "${parsed.name}" with a different identity exists`);
  saveKeyFile(parsed.name, parsed);
  const acct: AccountConfig = {
    name: parsed.name,
    identityAddress: parsed.identityAddress,
    payAddress: addressOf(keys.payPk),
    ordAddress: addressOf(keys.ordPk),
    dailyCapUsd: prev?.dailyCapUsd ?? null,
    stopped: prev?.stopped ?? false,
    importedAt: prev?.importedAt ?? Date.now(),
  };
  c.accounts[parsed.name] = acct;
  c.defaultAccount ??= parsed.name;
  writeConfig(c);
  appendLog(parsed.name, { at: Date.now(), action: 'import', detail: 'Key file imported', usd: 0 });
  return acct;
}

export async function unlock(name: string, passphrase?: string): Promise<AgentKeys> {
  const raw = readKeyFile(name);
  if (!raw) throw new Error(`No key file for ${name}`);
  const f = validateKeyFile(raw);
  return decryptKeyFile(f, passphrase ?? (await getPassphrase(`Passphrase for ${name}: `)));
}

export const listAccounts = () => {
  const c = readConfig();
  return Object.values(c.accounts).map((a) => {
    const l = getLoaded(a.name);
    return { ...a, default: c.defaultAccount === a.name, strategy: l ? `${l.strategy.name} v${l.strategy.version} (${l.mode})` : null };
  });
};

export async function balance(account?: string) {
  const a = resolveAccount(account);
  if (a.kind === 'paired') {
    const [b, usd] = await Promise.all([callPhone<PhoneBalance>(a.name, 'balance'), bsvUsd()]);
    const tokens = b.tokens.map((t) => ({ id: t.id, sym: t.sym, amount: Number(t.amount) / 10 ** (t.dec ?? 0), priceUsd: null, valueUsd: null }));
    const bsvValue = b.bsv.usd ?? (b.bsv.sats / 1e8) * usd;
    return { account: a.name, payAddress: '', ordAddress: '', bsvUsd: usd, bsv: { sats: b.bsv.sats, usd: bsvValue }, tokens, totalUsd: bsvValue, paper: (b.paper as PaperBook | null) ?? undefined };
  }
  const [usd, sats, toks] = await Promise.all([bsvUsd(), bsvBalanceSats(a.payAddress), tokenBalances(a.ordAddress)]);
  const tokens = await Promise.all(
    toks.slice(0, 20).map(async (t) => {
      const p = await tokenPrice(t.id).catch(() => null);
      return { ...t, priceUsd: p?.floorUsdPerToken ?? null, valueUsd: p?.floorUsdPerToken != null ? p.floorUsdPerToken * t.amount : null };
    }),
  );
  const bsvValue = (sats / 1e8) * usd;
  const l = getLoaded(a.name);
  return {
    account: a.name,
    payAddress: a.payAddress,
    ordAddress: a.ordAddress,
    bsvUsd: usd,
    bsv: { sats, usd: bsvValue },
    tokens,
    totalUsd: bsvValue + tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0),
    ...(l?.mode === 'paper' && { paper: getPaper(a.name) }),
  };
}

export const price = (tokenId: string) => {
  const id = normTokenId(tokenId);
  if (!TOKEN_ID.test(id)) throw new Error('Token must be a BSV-21 id (txid_vout)');
  return tokenPrice(id);
};

export type SendResult = { ok: boolean; paper?: boolean; text: string; txid?: string; sats?: number };

export async function send(usd: number, to: string, account?: string, opts: { passphrase?: string; satsPerKb?: number } = {}): Promise<SendResult> {
  const a = resolveAccount(account);
  if (!(usd > 0) || usd > 1e6) throw new Error('Amount must be a positive number of dollars');
  if (a.kind === 'paired') return phoneDo(a.name, 'send', { usd, to });
  const rate = await bsvUsd();
  const sats = Math.round((usd / rate) * 1e8);
  if (sats < 1) throw new Error('Amount is less than 1 satoshi');
  const g = gateAction(a.name, { kind: 'send', token: 'BSV', ticker: 'BSV', usd, to });
  if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
  if (g.paper) return { ok: true, paper: true, text: `Paper send of $${usd.toFixed(2)} to ${to} (nothing signed)`, sats };
  const rule = getLoaded(a.name)?.strategy.name;
  try {
    const keys = await unlock(a.name, opts.passphrase);
    const sender = a.identityAddress;
    const dest = await resolveDestination(to, sats, sender);
    const tx = await buildSend(keys.payPk, dest, opts.satsPerKb ?? readConfig().satsPerKb ?? DEFAULT_SATS_PER_KB);
    let txid: string;
    if (dest.p2p) {
      await notifyP2p(dest.p2p, tx, sender);
      txid = await broadcast(tx).catch(() => tx.id('hex'));
    } else txid = await broadcast(tx);
    appendLog(a.name, { at: Date.now(), action: 'send', detail: `Sent $${usd.toFixed(2)} (${sats} sats) to ${to}`, usd, txid, ...(rule && { rule }) });
    return { ok: true, text: `Sent $${usd.toFixed(2)} (${sats} sats) to ${to}`, txid, sats };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLog(a.name, { at: Date.now(), action: 'failed', detail: `Send $${usd.toFixed(2)} to ${to} failed: ${msg}`, usd: 0 });
    return { ok: false, text: `Send failed: ${msg}` };
  }
}

export type BuyResult = { ok: boolean; paper?: boolean; dryRun?: boolean; text: string; txid?: string; outpoint?: string; sats?: number };
export type BuyOpts = {
  passphrase?: string;
  satsPerKb?: number;
  /** Asked with the exact totals after the tx is built and verified, before broadcast. Omit to skip (agent/MCP). */
  confirm?: (question: string) => Promise<boolean>;
  /** Build + verify against the real listing with throwaway keys and a synthetic funding coin; never broadcasts. */
  dryRun?: boolean;
};

/** Cheapest whole listing that fits maxUsd and that the 1Sat overlay holds as valid (the app's `buyable`). */
async function pickBuyable(id: string, maxUsd: number) {
  const [rate, m] = await Promise.all([bsvUsd(), listings(id)]);
  const fits = m.listings.filter((l) => (l.priceSats / 1e8) * rate <= maxUsd + 1e-9);
  const valid = await overlayValid(id, fits.map((l) => l.outpoint));
  return { rate, m, pick: pickListing(fits.filter((l) => valid.has(l.outpoint)), maxUsd, rate), fits: fits.length };
}

const parseOutpoint = (o: string) => {
  const [txid, vout] = o.split('_');
  return { txid: txid!, vout: Number(vout) };
};

/**
 * Buy a BSV-21 token for at most maxUsd. Paper: fills at the floor. Live: takes the cheapest whole
 * buyable listing whose price fits, through the same gate (with the total incl. fees), then builds,
 * verifies every input script locally and broadcasts. See buy.ts.
 */
export async function buy(tokenId: string, maxUsd: number, account?: string, now = Date.now(), opts: BuyOpts = {}): Promise<BuyResult> {
  const id = normTokenId(tokenId);
  if (!TOKEN_ID.test(id)) throw new Error('Token must be a BSV-21 id (txid_vout)');
  if (!(maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  if (opts.dryRun) return buyDryRun(id, maxUsd);
  const a = resolveAccount(account);
  if (a.kind === 'paired') return phoneDo(a.name, 'buy', { tokenId: id, usd: maxUsd }) as Promise<BuyResult>;
  const loaded = getLoaded(a.name);
  const paper = loaded?.mode === 'paper';
  if (paper) {
    const [rate, m] = await Promise.all([bsvUsd(), listings(id)]);
    const floor = m.listings[0];
    if (!floor) return { ok: false, text: 'No live listings for that token' };
    const priceUsd = (floor.pricePerTokenSats / 1e8) * rate;
    const ticker = m.info.sym ?? undefined;
    const amount = maxUsd / priceUsd;
    const g = gateAction(a.name, { kind: 'buy', token: id, ticker, usd: maxUsd, priceUsd, amount }, {}, now);
    if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
    return { ok: true, paper: true, text: `Paper buy ${+amount.toFixed(6)} ${ticker ?? id} for $${maxUsd.toFixed(2)} @ $${priceUsd.toPrecision(4)}` };
  }

  // Choose a listing whose price leaves room for the 1% market fee: --max-usd is a hard ceiling on the total.
  const { rate, m, pick, fits } = await pickBuyable(id, maxUsd / 1.012);
  const ticker = m.info.sym ?? undefined;
  const name = ticker ?? id;
  if (!m.listings.length) return { ok: false, text: 'No live listings for that token' };
  if (!pick) {
    const per = (m.listings[0]!.pricePerTokenSats / 1e8) * rate;
    return { ok: false, text: fits ? `No buyable listing fits $${maxUsd.toFixed(2)} (the 1Sat overlay does not hold the ${fits} that fit as valid)` : `No listing fits $${maxUsd.toFixed(2)} (cheapest per token: $${per.toPrecision(3)})` };
  }
  const ovFee = await overlayFee(id);
  const feeSats = marketFeeSats(pick.priceSats);
  const totalSats = pick.priceSats + feeSats + (ovFee?.sats ?? 0);
  const usd = (totalSats / 1e8) * rate;
  if (usd > maxUsd + 1e-9) return { ok: false, text: `With fees the cheapest fit costs $${usd.toFixed(2)}, over --max-usd $${maxUsd.toFixed(2)}` };
  const priceUsd = (pick.pricePerTokenSats / 1e8) * rate;
  const g = gateAction(a.name, { kind: 'buy', token: id, ticker, usd, priceUsd, amount: pick.tokens }, {}, now);
  if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
  const rule = loaded?.strategy.name;
  const fail = (msg: string): BuyResult => {
    appendLog(a.name, { at: Date.now(), action: 'failed', detail: `Buy ${+pick.tokens.toFixed(6)} ${name} for $${usd.toFixed(2)} failed: ${msg}`, usd: 0 });
    return { ok: false, text: `Buy failed: ${msg}` };
  };
  try {
    const keys = await unlock(a.name, opts.passphrase);
    if (!(await outpointUnspent(pick.outpoint))) return fail('listing was just bought or cancelled');
    const op = parseOutpoint(pick.outpoint);
    const listingTx = Transaction.fromHex(await rawTx(op.txid));
    const coins = (await utxos(a.payAddress)).filter((u) => u.value > 1).sort((x, y) => y.value - x.value);
    const funding: { tx: Transaction; vout: number }[] = [];
    let have = 0;
    for (const u of coins) {
      if (have >= totalSats + 5000) break;
      funding.push({ tx: Transaction.fromHex(await rawTx(u.tx_hash)), vout: u.tx_pos });
      have += u.value;
    }
    const satsPerKb = opts.satsPerKb ?? readConfig().satsPerKb ?? DEFAULT_SATS_PER_KB;
    const tx = await buildPurchase({ listingTx, listingVout: op.vout, tokenId: id, buyerOrdAddress: a.ordAddress, payWif: keys.payPk, funding, overlayFee: ovFee, satsPerKb });
    const v = verifyPurchase(tx, { tokenId: id, buyerOrdAddress: a.ordAddress, payAddress: a.payAddress, overlayFee: ovFee });
    if (v.payoutSats !== pick.priceSats) return fail(`listing price changed (${v.payoutSats} sats on-chain vs ${pick.priceSats} listed)`);
    const allUsd = (v.totalSats / 1e8) * rate;
    const q = `Buy ${+pick.tokens.toFixed(6)} ${name} for $${allUsd.toFixed(2)} (${v.payoutSats} sats to seller + ${v.marketFeeSats} market fee${ovFee ? ` + ${ovFee.sats} overlay fee` : ''} + ${v.networkFee} network fee) from ${a.name}?`;
    if (opts.confirm && !(await opts.confirm(q))) return { ok: false, text: 'Not confirmed (pass --yes to skip)' };
    if (!(await outpointUnspent(pick.outpoint))) return fail('listing was just bought or cancelled');
    const txid = await broadcast(tx);
    try {
      await submitOverlay(tx.toBEEF(true), id);
    } catch {
      /* best effort, as in the app */
    }
    const detail = `Bought ${+pick.tokens.toFixed(6)} ${name} for $${allUsd.toFixed(2)} (${v.totalSats} sats) @ $${priceUsd.toPrecision(4)}`;
    appendLog(a.name, { at: Date.now(), action: 'buy', detail, usd: allUsd, txid, ...(rule && { rule }) });
    return { ok: true, text: detail, txid, outpoint: pick.outpoint, sats: v.totalSats };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** --dry-run: prove the OrdLock purchase input verifies against the real listing. Throwaway keys; never broadcasts. */
async function buyDryRun(id: string, maxUsd: number): Promise<BuyResult> {
  const { rate, m, pick } = await pickBuyable(id, maxUsd);
  if (!pick) return { ok: false, dryRun: true, text: m.listings.length ? `No buyable listing fits $${maxUsd.toFixed(2)}` : 'No live listings for that token' };
  const op = parseOutpoint(pick.outpoint);
  const unspent = await outpointUnspent(pick.outpoint);
  const listingTx = Transaction.fromHex(await rawTx(op.txid));
  const ovFee = await overlayFee(id);
  const pay = PrivateKey.fromRandom();
  const ord = PrivateKey.fromRandom();
  const parent = new Transaction();
  parent.addOutput({ lockingScript: new P2PKH().lock(pay.toAddress()), satoshis: pick.priceSats * 2 + 100_000 });
  const tx = await buildPurchase({ listingTx, listingVout: op.vout, tokenId: id, buyerOrdAddress: ord.toAddress(), payWif: pay.toWif(), funding: [{ tx: parent, vout: 0 }], overlayFee: ovFee });
  const v = verifyPurchase(tx, { tokenId: id, buyerOrdAddress: ord.toAddress(), payAddress: pay.toAddress(), overlayFee: ovFee });
  const usd = (v.totalSats / 1e8) * rate;
  return {
    ok: true,
    dryRun: true,
    outpoint: pick.outpoint,
    sats: v.totalSats,
    text:
      `Dry run OK: ${pick.outpoint} (${unspent ? 'unspent' : 'SPENT'}) ${+pick.tokens.toFixed(6)} ${m.info.sym ?? id} for $${usd.toFixed(2)}: ` +
      `${v.payoutSats} sats to seller + ${v.marketFeeSats} market fee${ovFee ? ` + ${ovFee.sats} overlay fee` : ''} + ${v.networkFee} network fee. ` +
      `All ${tx.inputs.length} input scripts verified (incl. the OrdLock purchase against the real listing). Synthetic funding; nothing signed with your keys, nothing broadcast.`,
  };
}

export async function strategyLoad(file: string, account: string | undefined, live: boolean, now = Date.now()) {
  const a = resolveAccount(account);
  const r = parseStrategy(readFileSync(file, 'utf8'));
  if (!r.ok) throw new Error(`Strategy refused:\n  - ${r.errors.join('\n  - ')}`);
  if (a.kind === 'paired') {
    if (live) throw new Error('A paired account loads strategies on paper; switch to live in bWalletX (Agents › Strategy › Run live).');
    await callPhone(a.name, 'strategy_load', { strategy: r.strategy });
    return { account: a.name, mode: 'paper' as const, strategy: r.strategy };
  }
  const mode: Loaded['mode'] = live ? 'live' : 'paper';
  let startValueUsd: number | undefined;
  if (live && r.strategy.rules.stop?.downPct) startValueUsd = (await balance(a.name)).totalUsd;
  setLoaded(a.name, { strategy: r.strategy, mode, loadedAt: now, ...(startValueUsd !== undefined && { startValueUsd }) });
  if (mode === 'paper') setPaper(a.name, null);
  appendLog(a.name, { at: now, action: 'strategy', detail: `Loaded ${r.strategy.name} v${r.strategy.version} (${mode})`, usd: 0 });
  return { account: a.name, mode, strategy: r.strategy };
}

export const strategyShow = async (account?: string) => {
  const a = resolveAccount(account);
  if (a.kind === 'paired') {
    const l = await callPhone<Loaded | null>(a.name, 'strategy_show');
    return l ? { account: a.name, ...l } : { account: a.name, strategy: null };
  }
  const l = getLoaded(a.name);
  return l ? { account: a.name, ...l, ...(l.mode === 'paper' && { paper: getPaper(a.name) }) } : { account: a.name, strategy: null };
};

export const strategyUnload = (account?: string) => {
  const a = resolveAccount(account);
  if (a.kind === 'paired') throw new Error('Unload a paired account’s strategy in bWalletX (Agents › Strategy › Unload).');
  const l = getLoaded(a.name);
  if (!l) return false;
  setLoaded(a.name, null);
  appendLog(a.name, { at: Date.now(), action: 'strategy', detail: `Unloaded ${l.strategy.name}`, usd: 0 });
  return true;
};

export const log = async (account?: string, limit = 50) => {
  const a = resolveAccount(account);
  if (a.kind === 'paired') return callPhone<AgentLogEntry[]>(a.name, 'log', { limit });
  return readLog(a.name).slice(-limit);
};
