/** Operations shared by the CLI, `agent run` and the MCP server. Every spend goes through gateAction. */
import { readFileSync } from 'node:fs';
import { decryptKeyFile, validateKeyFile, type AgentKeys } from './keyfile.js';
import { bsvBalanceSats, bsvUsd, listings, normTokenId, pickListing, tokenBalances, tokenPrice, TOKEN_ID } from './market.js';
import { getPassphrase } from './passphrase.js';
import { gateAction } from './gate.js';
import { parseStrategy, type Loaded } from './strategy.js';
import {
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
import { addressOf, broadcast, buildSend, notifyP2p, resolveDestination, DEFAULT_SATS_PER_KB } from './wallet.js';

export const LIVE_BUY_UNSUPPORTED = 'live buy not yet supported in CLI; use paper or the app';

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

export type BuyResult = { ok: boolean; paper?: boolean; text: string; txid?: string };

/** Buy a BSV-21 token for at most maxUsd. Paper: fills at the floor. Live: not yet (see LIVE_BUY_UNSUPPORTED). */
export async function buy(tokenId: string, maxUsd: number, account?: string, now = Date.now()): Promise<BuyResult> {
  const a = resolveAccount(account);
  const id = normTokenId(tokenId);
  if (!TOKEN_ID.test(id)) throw new Error('Token must be a BSV-21 id (txid_vout)');
  if (!(maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  const [rate, m] = await Promise.all([bsvUsd(), listings(id)]);
  const ticker = m.info.sym ?? undefined;
  const floor = m.listings[0];
  if (!floor) return { ok: false, text: 'No live listings for that token' };
  const priceUsd = (floor.pricePerTokenSats / 1e8) * rate;
  const loaded = getLoaded(a.name);
  const paper = loaded?.mode === 'paper';
  // Paper fills a fractional amount at the floor; live must take a whole listing that fits.
  const pick = paper ? null : pickListing(m.listings, maxUsd, rate);
  if (!paper && !pick) return { ok: false, text: `No listing fits $${maxUsd.toFixed(2)} (cheapest per token: $${priceUsd.toPrecision(3)})` };
  const usd = paper ? maxUsd : (pick!.priceSats / 1e8) * rate;
  const amount = paper ? usd / priceUsd : pick!.tokens;
  const g = gateAction(a.name, { kind: 'buy', token: id, ticker, usd, priceUsd, amount }, {}, now);
  if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
  if (g.paper) return { ok: true, paper: true, text: `Paper buy ${+amount.toFixed(6)} ${ticker ?? id} for $${usd.toFixed(2)} @ $${priceUsd.toPrecision(4)}` };
  appendLog(a.name, { at: now, action: 'failed', detail: `Buy ${ticker ?? id} for $${usd.toFixed(2)}: ${LIVE_BUY_UNSUPPORTED}`, usd: 0 });
  return { ok: false, text: LIVE_BUY_UNSUPPORTED };
}

export async function strategyLoad(file: string, account: string | undefined, live: boolean, now = Date.now()) {
  const a = resolveAccount(account);
  const r = parseStrategy(readFileSync(file, 'utf8'));
  if (!r.ok) throw new Error(`Strategy refused:\n  - ${r.errors.join('\n  - ')}`);
  const mode: Loaded['mode'] = live ? 'live' : 'paper';
  let startValueUsd: number | undefined;
  if (live && r.strategy.rules.stop?.downPct) startValueUsd = (await balance(a.name)).totalUsd;
  setLoaded(a.name, { strategy: r.strategy, mode, loadedAt: now, ...(startValueUsd !== undefined && { startValueUsd }) });
  if (mode === 'paper') setPaper(a.name, null);
  appendLog(a.name, { at: now, action: 'strategy', detail: `Loaded ${r.strategy.name} v${r.strategy.version} (${mode})`, usd: 0 });
  return { account: a.name, mode, strategy: r.strategy };
}

export const strategyShow = (account?: string) => {
  const a = resolveAccount(account);
  const l = getLoaded(a.name);
  return l ? { account: a.name, ...l, ...(l.mode === 'paper' && { paper: getPaper(a.name) }) } : { account: a.name, strategy: null };
};

export const strategyUnload = (account?: string) => {
  const a = resolveAccount(account);
  const l = getLoaded(a.name);
  if (!l) return false;
  setLoaded(a.name, null);
  appendLog(a.name, { at: Date.now(), action: 'strategy', detail: `Unloaded ${l.strategy.name}`, usd: 0 });
  return true;
};

export const log = (account?: string, limit = 50) => {
  const a = resolveAccount(account);
  return readLog(a.name).slice(-limit);
};
