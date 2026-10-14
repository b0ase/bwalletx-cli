/**
 * Wiring for `bwalletx opns …`: the agent account's own BRC-100 wallet (the CLI's local wallet-toolbox store,
 * keys decrypted into memory only), the 1Sat indexer, the multi-core miner and the batch runner (batch.ts).
 * Non-custodial: the account is the owner's own agent sub-account; nothing passes through a bWalletX server.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Beef, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, type WalletInterface } from '@bsv/sdk';
import { broadcast, rawTx, utxos } from '../wallet.js';
import { cancelOpnsListing, listOpns, sellOpns, sendOpns, type OneSatContext } from '@1sat/actions';
import { brc100Account, withdrawFrom } from '../brc100Actions.js';
import { bsvUsd } from '../market.js';
import { allStopped, appendLog, home, readConfig } from '../store.js';
import {
  buildQueue,
  mergeState,
  newState,
  parseNameList,
  progressLine,
  reportHtml,
  runHeadless,
  summarise,
  type RunResult,
  type State,
} from './batch.js';
import { benchmark, getThreads, setThreads } from './miner.js';
import { estimateMintFee, fetchMineNode } from './opnsMint.js';
import { mineName } from './opnsRegister.js';
import { fileKV, OpnsTree } from './opnsTree.js';
import { indexerFetch } from './services.js';

const safe = (s: string) => s.replace(/[^\w.-]/g, '_');
export const statePath = (account: string) => join(home(), `opns-batch-${safe(account)}.json`);
export const reportPath = (account: string) => join(home(), `opns-batch-${safe(account)}.html`);
export const treePath = (account: string) => join(home(), `opns-tree-${safe(account)}.json`);

/** OpNS node script is ~5,975 bytes; per-character fee at 100 sat/kB (bWalletX estimateMintFee). */
export const NODE_SCRIPT_LEN = 6000;
export const PER_CHAR_SATS = estimateMintFee(NODE_SCRIPT_LEN);
/** One OrdLock v2 listing tx (name input + funding + change) — bWalletX OPNS_LIST_FEE_ESTIMATE. */
export const LIST_FEE_SATS = 200;

export const loadState = (account: string): State | null => {
  try {
    const s = JSON.parse(readFileSync(statePath(account), 'utf8')) as State;
    return s?.v === 1 && Array.isArray(s.items) ? s : null;
  } catch {
    return null;
  }
};

let lastReport = 0;
export const saveState = (s: State, force = false) => {
  writeFileSync(statePath(s.account), JSON.stringify(s), { mode: 0o600 });
  // The HTML page is cosmetic: at most every 5 s (big lists).
  if (force || Date.now() - lastReport > 5000) {
    lastReport = Date.now();
    writeFileSync(reportPath(s.account), reportHtml(s), { mode: 0o600 });
  }
};

const readList = (file: string) => {
  const r = parseNameList(readFileSync(file, 'utf8'));
  return { file, ...r };
};

const accountName = (a?: string) => {
  const n = a ?? readConfig().defaultAccount ?? Object.keys(readConfig().accounts)[0];
  if (!n) throw new Error('No accounts yet. Run `bwalletx key import <file>`.');
  return n;
};

/** Lists → queue, merged with a saved job when there is one. No network. */
export const prepare = (o: {
  account?: string;
  files: string[];
  vault?: string;
  gift?: string;
  to?: string;
  payTo?: string;
  budgetSats?: number;
  fresh?: boolean;
  prune?: boolean;
  listsOnly?: boolean;
}) => {
  const account = accountName(o.account);
  const lists = o.files.map(readList);
  const vault = o.vault ? readList(o.vault) : null;
  const gift = o.gift ? readList(o.gift) : null;
  if ((vault?.names.length || gift?.names.length) && !o.to && !loadState(account)?.to)
    throw new Error('--vault/--gift names are locked to your ordinals address: give it with --to <address>');
  const invalid = [...lists, ...(vault ? [vault] : []), ...(gift ? [gift] : [])].flatMap((l) => l.invalid.map((n) => `${l.file}: ${n}`));
  const queue = buildQueue(
    lists.map((l) => l.names),
    vault?.names,
    gift?.names,
    o.listsOnly,
  );
  const saved = o.fresh ? null : loadState(account);
  const state = saved
    ? mergeState(saved, queue, { to: o.to, payTo: o.payTo, budgetSats: o.budgetSats }, o.prune)
    : newState(account, queue, { to: o.to, payTo: o.payTo, budgetSats: o.budgetSats ?? 0 });
  if (!(state.budgetSats > 0)) throw new Error('Give a spending limit with --budget <sats> (it is remembered for later runs).');
  return { account, state, invalid };
};

/** Toolbox (CommonJS) services for node BEEF, converted to the ESM SDK the OpNS code uses. */
const require = createRequire(import.meta.url);
const oneSatServices = () => {
  const toolbox = require('@bsv/wallet-toolbox') as typeof import('@bsv/wallet-toolbox');
  const s = new toolbox.Services('main');
  return {
    // A node we broadcast seconds ago may not be at the toolbox providers yet: try for ~2 minutes before giving up.
    getBeefForTxid: async (txid: string) => {
      for (let i = 1; ; i++) {
        try {
          return Beef.fromBinary((await s.getBeefForTxid(txid)).toBinary());
        } catch (e) {
          if (i >= 5) throw e;
          await new Promise((r) => setTimeout(r, 10_000 * i));
        }
      }
    },
  } as unknown as OneSatContext['services'];
};

/** The wallet's OPNS-basket id for a name that is ours and not listed (bWalletX opnsBuy.ts opnsIdFor). */
const opnsIdFor = async (ctx: OneSatContext, name: string): Promise<string | undefined> => {
  const r = await listOpns.execute(ctx, { names: [name], includeTags: true, limit: 50 });
  for (const o of r.outputs) {
    if (!o.tags?.includes(`name:${name}`) || o.tags.some((t) => t.startsWith('ordlock'))) continue;
    return o.tags.find((t) => t.startsWith('id:'))?.slice(3) ?? o.outpoint;
  }
  // Outputs returned by a cancelled listing carry no name: tag; their name is in customInstructions.
  const all = await listOpns.execute(ctx, { includeTags: true, includeCustomInstructions: true, limit: 10_000 });
  for (const o of all.outputs) {
    if (o.tags?.some((t) => t.startsWith('ordlock'))) continue;
    try {
      if ((JSON.parse(o.customInstructions ?? '') as { name?: unknown }).name !== name) continue;
    } catch {
      continue;
    }
    return o.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o.outpoint;
  }
  return undefined;
};

const listedIn = async (ctx: OneSatContext, name: string) => {
  const r = await listOpns.execute(ctx, { names: [name], includeTags: true, limit: 50 });
  return r.outputs.some((o) => o.tags?.includes(`name:${name}`) && o.tags.some((t) => t.startsWith('ordlock')));
};

export type MintOptions = {
  account?: string;
  files: string[];
  vault?: string;
  gift?: string;
  to?: string;
  payTo?: string;
  budgetSats?: number;
  threads?: number;
  fresh?: boolean;
  quiet?: boolean;
  /** Drop pending names that are not in these lists (so another machine can take them). */
  prune?: boolean;
  /** Vault/gift files route only; they add no names (a second machine). */
  listsOnly?: boolean;
};

export async function opnsMint(o: MintOptions): Promise<RunResult> {
  const { account, state, invalid } = prepare(o);
  if (invalid.length) console.error(`Ignored ${invalid.length} invalid name(s): ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? '…' : ''}`);
  if (o.threads) setThreads(o.threads);
  saveState(state, true);

  const { name, keys, b, w } = await brc100Account(account);
  w.startMonitor();
  const ctx: OneSatContext = { wallet: w.wallet as unknown as WalletInterface, chain: 'main', services: oneSatServices(), dataDir: home(), isBaseWallet: true };
  const f = indexerFetch();
  const tree = new OpnsTree(fileKV(treePath(name)), 'tree');

  // Pick up BSV sent to the account's own addresses since the last run (nothing leaves the account).
  const funded = await b.fundFromPayAddress(w, keys).catch(() => null);
  if (funded?.moved) appendLog(name, { at: Date.now(), action: 'brc100-fund', detail: `Moved ${funded.sats} sats into the BRC-100 wallet`, usd: 0 });

  let rate = 0;
  let rateAt = 0;
  const ctl = new AbortController();
  let interrupts = 0;
  const onSig = () => {
    interrupts++;
    if (interrupts === 1) {
      console.error('\nStopping after the current step (saved; run the same command to resume). Ctrl-C again to quit now.');
      ctl.abort();
    } else process.exit(130);
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  const runStart = Date.now();
  let lastLine = 0;
  const tty = process.stdout.isTTY && !o.quiet;
  try {
    const res = await runHeadless(
      {
        fetch: f,
        mine: (n, lockTo, signal, onProgress) => mineName({ ctx, fetch: f, tree, lockTo }, n, signal, onProgress),
        list: async (n, sats) => {
          const id = await opnsIdFor(ctx, n);
          if (!id) throw new Error(`"${n}" not found in the agent wallet`);
          const r = await sellOpns.execute(ctx, { id, price: sats, ...(state.payTo ? { payAddress: state.payTo } : {}) });
          if (r.error || !r.txid) throw new Error(String(r.error ?? 'Listing failed'));
          await w.sendWaiting();
          appendLog(name, { at: Date.now(), action: 'opns-list', detail: `${n} for ${sats} sats ${r.txid}`, usd: 0 });
          return r.txid;
        },
        isListed: (n) => listedIn(ctx, n),
        rate: async () => {
          if (!rate || Date.now() - rateAt > 10 * 60_000) {
            rate = await bsvUsd();
            rateAt = Date.now();
          }
          return rate;
        },
        charsNeeded: async (n) => {
          const local = tree.best(n);
          const idx = await fetchMineNode(f, n).catch(() => null);
          const d = [local?.domain, idx && !tree.isSpent(idx.outpoint) ? idx.domain : undefined].filter((x): x is string => typeof x === 'string');
          return d.length ? n.length - Math.max(...d.map((x) => x.length)) : null;
        },
        isOurs: (n) => tree.isOurs(n),
        balance: () => b.walletBalance(w),
        stopped: () => allStopped() || !!readConfig().accounts[name]?.stopped,
        perCharSats: PER_CHAR_SATS,
        listFeeSats: LIST_FEE_SATS,
        save: (s) => saveState(s),
        onUpdate: (s, p) => {
          if (o.quiet) return;
          const now = Date.now();
          if (p && now - lastLine < 500) return;
          lastLine = now;
          const line = progressLine(s, p);
          if (tty) process.stdout.write(`\r\x1b[2K${line.slice(0, (process.stdout.columns || 160) - 1)}`);
          else if (!p) console.log(line);
        },
      },
      state,
      ctl.signal,
    );
    saveState(res.state, true);
    if (tty) process.stdout.write('\n');
    for (const it of res.state.items)
      if (it.doneAt && it.doneAt >= runStart && it.txids.length)
        appendLog(name, { at: it.doneAt, action: 'opns-mint', detail: `${it.name} (${it.route}) ${it.txids.join(',')}`, usd: 0 });
    return res;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    await w.sendWaiting().catch(() => undefined);
    await w.close();
  }
}

export function opnsStatus(account?: string) {
  const n = accountName(account);
  const s = loadState(n);
  if (!s) return null;
  return { account: n, state: statePath(n), report: reportPath(n), stopped: s.stopped, to: s.to, payTo: s.payTo, ...summarise(s), threads: getThreads() };
}

/**
 * Give the owner everything back: unsold listings are cancelled, every name left in the agent wallet is sent to
 * `to`, then (unless namesOnly) the remaining sats are withdrawn to `payTo ?? to`.
 */
/** Cancel the sale listings of the named OpNS names and send them to `to` (reserved brands/countries/cities: owner, 14 Oct 2026). */
export async function opnsUnlist(o: { account?: string; names: string[]; to: string; dryRun?: boolean }) {
  const { name, w } = await brc100Account(accountName(o.account));
  w.startMonitor();
  const ctx: OneSatContext = { wallet: w.wallet as unknown as WalletInterface, chain: 'main', services: oneSatServices(), dataDir: home(), isBaseWallet: true };
  const want = new Set(o.names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const out: { name: string; action: string; txid?: string; error?: string }[] = [];
  try {
    // Listing outputs carry no name: tag; the name lives in customInstructions (as @1sat/actions nameFromOutput reads it).
    const outputs = (await listOpns.execute(ctx, { includeTags: true, includeCustomInstructions: true, limit: 10_000 })).outputs;
    const nameOf = (o2: (typeof outputs)[number]) => {
      const t = o2.tags?.find((x) => x.startsWith('name:'))?.slice(5);
      if (t) return t.toLowerCase();
      try {
        const n = (JSON.parse(o2.customInstructions ?? '') as { name?: unknown }).name;
        return typeof n === 'string' ? n.toLowerCase() : '';
      } catch {
        return '';
      }
    };
    const seen = new Set<string>();
    for (const o2 of outputs) {
      const nm = nameOf(o2);
      if (!want.has(nm) || seen.has(nm) || !o2.tags?.some((t) => t.startsWith('ordlock'))) continue;
      seen.add(nm);
      let id = o2.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o2.outpoint;
      if (o.dryRun) {
        out.push({ name: nm, action: 'would unlist and send' });
        continue;
      }
      try {
        const c = await cancelOpnsListing.execute(ctx, { id });
        if (c.error) throw new Error(String(c.error));
        out.push({ name: nm, action: 'unlisted', txid: c.txid });
        await w.sendWaiting();
        // The returned output has no name: tag either; find it by the cancel txid (its vout 0).
        const back = (await listOpns.execute(ctx, { includeTags: true, includeCustomInstructions: true, limit: 10_000 })).outputs.find(
          (x) => x.outpoint.startsWith(`${c.txid}.`) || x.outpoint.startsWith(`${c.txid}_`),
        );
        id = back?.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? back?.outpoint ?? (await opnsIdFor(ctx, nm)) ?? id;
        const s = await sendOpns.execute(ctx, { id, address: o.to });
        if (s.error || !s.txid) throw new Error(String(s.error ?? 'send failed'));
        out.push({ name: nm, action: 'sent', txid: s.txid });
        appendLog(name, { at: Date.now(), action: 'opns-unlist', detail: `${nm} → ${o.to} ${s.txid}`, usd: 0 });
      } catch (e) {
        out.push({ name: nm, action: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const nm of want) if (!seen.has(nm)) out.push({ name: nm, action: 'not listed here' });
    const listings = outputs.filter((o2) => o2.tags?.some((t) => t.startsWith('ordlock'))).length;
    out.unshift({ name: '(wallet)', action: `${outputs.length} OpNS outputs, ${listings} listed for sale` });
    await w.sendWaiting();
    return { account: name, names: out };
  } finally {
    await w.close();
  }
}
export async function opnsSweep(o: { account?: string; to: string; payTo?: string; namesOnly?: boolean; keepListed?: boolean }) {
  const { name, b, w } = await brc100Account(accountName(o.account));
  w.startMonitor();
  const ctx: OneSatContext = { wallet: w.wallet as unknown as WalletInterface, chain: 'main', services: oneSatServices(), dataDir: home(), isBaseWallet: true };
  const out: { name: string; action: string; txid?: string; error?: string }[] = [];
  try {
    const r = await listOpns.execute(ctx, { includeTags: true, limit: 10_000 });
    for (const o2 of r.outputs) {
      const nm = o2.tags?.find((t) => t.startsWith('name:'))?.slice(5) ?? o2.outpoint;
      let id = o2.tags?.find((t) => t.startsWith('id:'))?.slice(3) ?? o2.outpoint;
      try {
        if (o2.tags?.some((t) => t.startsWith('ordlock'))) {
          if (o.keepListed) continue;
          const c = await cancelOpnsListing.execute(ctx, { id });
          if (c.error) throw new Error(String(c.error));
          out.push({ name: nm, action: 'unlisted', txid: c.txid });
          id = (await opnsIdFor(ctx, nm)) ?? id;
        }
        const s = await sendOpns.execute(ctx, { id, address: o.to });
        if (s.error || !s.txid) throw new Error(String(s.error ?? 'send failed'));
        out.push({ name: nm, action: 'sent', txid: s.txid });
        appendLog(name, { at: Date.now(), action: 'opns-sweep', detail: `${nm} → ${o.to} ${s.txid}`, usd: 0 });
      } catch (e) {
        out.push({ name: nm, action: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    }
    await w.sendWaiting();
    let sats: { txid?: string; sats: number } | null = null;
    if (!o.namesOnly) {
      const have = await b.walletBalance(w);
      if (have > 1000) {
        sats = await withdrawFrom(name, w, { amount: 'all', address: o.payTo ?? o.to, have, rate: await bsvUsd(), relay: b.relayToArc });
      }
    }
    return { account: name, names: out, sats };
  } finally {
    await w.close();
  }
}

export async function opnsBench(seconds = 8, threads?: number) {
  const r = await benchmark(seconds, threads ?? getThreads());
  const secsPerChar = r.rate > 0 ? 2 ** 22 / r.rate : Infinity;
  return { ...r, mhs: r.rate / 1e6, secsPerChar };
}

/** For the runbook / plan: funding needed for a set of lists (chars from a quick local estimate). */
export const fundingFor = (chars: number, listed: number) => chars * PER_CHAR_SATS + listed * LIST_FEE_SATS;

/**
 * Where a vault/gift name minted by this job sits: the 1-sat output of its last mint tx that pays the account's own
 * ordinals address (P2PKH followed by the inscription envelope). Those outputs are outside the BRC-100 wallet's
 * baskets, so sendOpns cannot see them; WhatsOnChain does not index them by address either.
 */
const giftOutpoint = async (account: string, nm: string, ordAddress: string): Promise<{ tx: Transaction; vout: number } | null> => {
  const st = loadState(account);
  const it = st?.items.find((i) => i.name === nm && i.status === 'done');
  const txid = it?.txids.at(-1);
  if (!txid) return null;
  const tx = Transaction.fromHex(await rawTx(txid));
  const p2pkh = new P2PKH().lock(ordAddress).toHex();
  const vout = tx.outputs.findIndex((o) => o.satoshis === 1 && o.lockingScript.toHex().startsWith(p2pkh));
  return vout < 0 ? null : { tx, vout };
};

/** Send named OpNS names from the agent account to one address (gifts: owner, 13 Oct 2026). Listed names are skipped. */
export async function opnsSend(o: { account?: string; names: string[]; to: string; dryRun?: boolean }) {
  const { name, keys, b, w } = await brc100Account(accountName(o.account));
  w.startMonitor();
  const ctx: OneSatContext = { wallet: w.wallet as unknown as WalletInterface, chain: 'main', services: oneSatServices(), dataDir: home(), isBaseWallet: true };
  const ordKey = PrivateKey.fromWif(keys.ordPk);
  const payKey = PrivateKey.fromWif(keys.payPk);
  const ordAddress = ordKey.toAddress();
  const payAddress = payKey.toAddress();
  const out: { name: string; action: string; txid?: string; error?: string }[] = [];
  // Fee coins come from the pay address. The minter moved everything into the BRC-100 wallet, so top it up from
  // there once (a few thousand sats) and wait for the coin to show.
  const feeCoins = async () => {
    let coins = (await utxos(payAddress)).filter((u) => u.value > 1);
    if (coins.length) return coins;
    if (o.dryRun) return coins;
    const have = await b.walletBalance(w);
    const rate = await bsvUsd();
    const topUp = await withdrawFrom(name, w, { amount: (5000 / 1e8) * rate, address: payAddress, have, rate, relay: b.relayToArc });
    for (let i = 0; i < 12 && !coins.length; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      coins = (await utxos(payAddress)).filter((u) => u.value > 1);
    }
    if (!coins.length) throw new Error(`fee top-up ${topUp?.txid ?? ''} not visible yet; try again in a minute`);
    return coins;
  };
  try {
    for (const raw of o.names) {
      const nm = raw.trim().toLowerCase();
      try {
        const id = await opnsIdFor(ctx, nm);
        if (id) {
          if (o.dryRun) {
            out.push({ name: nm, action: 'would send (wallet basket)' });
            continue;
          }
          const s = await sendOpns.execute(ctx, { id, address: o.to });
          if (s.error || !s.txid) throw new Error(String(s.error ?? 'send failed'));
          out.push({ name: nm, action: 'sent', txid: s.txid });
          appendLog(name, { at: Date.now(), action: 'opns-send', detail: `${nm} → ${o.to} ${s.txid}`, usd: 0 });
          continue;
        }
        const g = await giftOutpoint(name, nm, ordAddress);
        if (!g) throw new Error('not in this account (or listed for sale)');
        const coins = await feeCoins();
        if (o.dryRun) {
          out.push({ name: nm, action: `would send ${g.tx.id('hex')}.${g.vout} (fee from ${coins.length} coin(s) at ${payAddress})` });
          continue;
        }
        const tx = new Transaction();
        tx.addInput({ sourceTransaction: g.tx, sourceOutputIndex: g.vout, unlockingScriptTemplate: new P2PKH().unlock(ordKey) });
        const c = coins.sort((x, y) => y.value - x.value)[0];
        tx.addInput({ sourceTransaction: Transaction.fromHex(await rawTx(c.tx_hash)), sourceOutputIndex: c.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(payKey) });
        tx.addOutput({ lockingScript: new P2PKH().lock(o.to), satoshis: 1 });
        tx.addOutput({ lockingScript: new P2PKH().lock(payAddress), change: true });
        await tx.fee(new SatoshisPerKilobyte(100));
        await tx.sign();
        const txid = await broadcast(tx);
        out.push({ name: nm, action: 'sent', txid });
        appendLog(name, { at: Date.now(), action: 'opns-send', detail: `${nm} → ${o.to} ${txid}`, usd: 0 });
      } catch (e) {
        out.push({ name: nm, action: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    }
    await w.sendWaiting();
    return { account: name, names: out };
  } finally {
    await w.close();
  }
}
