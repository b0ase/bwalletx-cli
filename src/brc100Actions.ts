/** BRC-100 wallet operations shared by the CLI (`bwalletx brc100 …`) and the MCP server. */
import { P2PKH, PrivateKey } from '@bsv/sdk';
import { unlock } from './actions.js';
import { gateAction } from './gate.js';
import { bsvUsd } from './market.js';
import { isPaired, readPairing } from './paired.js';
import { appendLog, readConfig, resolveAccount } from './store.js';
import type { AgentWallet } from './brc100.js';

const accountName = (name?: string) => {
  const n = name ?? readConfig().defaultAccount ?? Object.keys(readConfig().accounts)[0];
  if (!n) throw new Error('No accounts yet. Run `bwalletx key import <file>`.');
  return n;
};

/** Open the agent account as a BRC-100 wallet: the CLI's own (default) or the 1Sat Storage one (`shared`). */
export async function brc100Account(name?: string, shared = false) {
  const n = accountName(name);
  if (isPaired(n)) throw new Error(`"${n}" is paired: its keys stay on the phone, so it can't run as a BRC-100 wallet here. Import an agent key file for this.`);
  resolveAccount(n);
  const keys = await unlock(n);
  const b = await import('./brc100.js');
  // Default: the CLI's own wallet. `shared` opens the account's 1Sat Storage wallet, which only stays in step
  // with the app if the app uses that remote as the account's active storage (it normally doesn't).
  return { name: n, keys, b, w: shared ? await b.openSharedWallet(keys) : await b.openWallet(n, keys) };
}

/** Move the account's own pay-address / app-receive BSV into its own BRC-100 wallet. Nothing leaves the account. */
export async function brc100Fund(account?: string, shared = false) {
  const { name, keys, b, w } = await brc100Account(account, shared);
  try {
    const r = await b.fundFromPayAddress(w, keys);
    appendLog(name, { at: Date.now(), action: 'brc100-fund', detail: `Moved ${r.moved} coins (${r.sats} sats) into the BRC-100 wallet`, usd: 0 });
    return { name, payAddress: w.payAddress, result: r };
  } finally {
    await w.close();
  }
}

export async function brc100Balance(account?: string, shared = false) {
  const { name, b, w } = await brc100Account(account, shared);
  try {
    const sats = await b.walletBalance(w);
    const rate = await bsvUsd();
    return { account: name, identityKey: w.identityKey, sats, usd: (sats / 1e8) * rate };
  } finally {
    await w.close();
  }
}

/** Pay address + the bWalletX app's receive addresses. Refused for paired accounts (keys on the phone). */
export async function brc100Addresses(account?: string) {
  const n = account ?? readConfig().defaultAccount ?? Object.keys(readConfig().accounts)[0];
  if (!n) throw new Error('No accounts yet.');
  if (isPaired(n)) throw new Error(`"${n}" is paired: its keys stay on the phone.`);
  const keys = await unlock(n);
  const { appAddresses } = await import('./brc100.js');
  return [{ label: 'pay address', address: PrivateKey.fromWif(keys.payPk).toAddress() }, ...appAddresses(keys.identityPk, 5).map(({ label, address }) => ({ label, address }))];
}

type WithdrawWallet = Pick<AgentWallet, 'wallet' | 'sendWaiting'>;

/** The withdraw itself, given an open wallet: gate (as a `send`), refuse paper, sign, broadcast, relay, log. */
export async function withdrawFrom(
  name: string,
  w: WithdrawWallet,
  o: { amount: number | 'all'; address: string; have: number; rate: number; relay?: (r: unknown) => Promise<unknown> },
) {
  const sats = o.amount === 'all' ? o.have - 300 : Math.round((o.amount / o.rate) * 1e8);
  if (!(sats > 0) || sats > o.have) throw new Error(`Can't send ${sats} sats: the wallet holds ${o.have}`);
  const usd = (sats / 1e8) * o.rate;
  const g = gateAction(name, { kind: 'send', token: 'BSV', usd, to: o.address });
  if (!g.ok) throw new Error(`Refused: ${g.reason}`);
  if (g.paper) throw new Error('Paper mode: nothing is signed');
  const r = await w.wallet.createAction(
    { description: 'bwalletx withdraw', outputs: [{ lockingScript: new P2PKH().lock(o.address).toHex(), satoshis: sats, outputDescription: 'withdraw' }], options: { acceptDelayedBroadcast: false } },
    'bwalletx-cli',
  );
  await w.sendWaiting();
  if (o.relay) await o.relay(r).catch(() => undefined);
  appendLog(name, { at: Date.now(), action: 'send', detail: `BRC-100 withdraw ${sats} sats to ${o.address} ${r.txid ?? ''}`, usd });
  return { txid: r.txid, sats };
}

export async function brc100Withdraw(amount: number | 'all', address: string, account?: string, shared = false) {
  const { name, b, w } = await brc100Account(account, shared);
  try {
    const rate = await bsvUsd();
    const have = await b.walletBalance(w);
    return await withdrawFrom(name, w, { amount, address, have, rate, relay: b.relayToArc });
  } finally {
    await w.close();
  }
}

/** Whether an account is paired and how. Never returns pairing secrets. */
export function pairingStatus(account?: string, now = Date.now()) {
  const n = account ?? readConfig().defaultAccount ?? Object.keys(readConfig().accounts)[0];
  if (!n) throw new Error('No accounts yet.');
  const keyFile = !!readConfig().accounts[n] && !isPaired(n);
  const p = readPairing(n);
  if (!p) return { account: n, paired: false, keyFile };
  return {
    account: n,
    paired: true,
    mode: p.mode === 'brc100' ? ('brc100 (main wallet)' as const) : ('agent' as const),
    phoneAccount: p.account,
    identityAddress: p.identityAddress,
    scopes: p.scopes,
    pairedAt: p.pairedAt,
    expiresAt: p.expiresAt,
    expired: p.expiresAt <= now,
    lastSeen: p.lastSeen,
    ...(p.mint && { mint: p.mint }),
    ...(p.caps && { caps: p.caps }),
  };
}

/** Is something answering on the `serve` port? (Which account it serves is not knowable from outside.) */
export async function serveStatus(port = 3321, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://localhost:${port}/getVersion`, { method: 'OPTIONS', signal: AbortSignal.timeout(timeoutMs) });
    return { port, listening: true, status: r.status };
  } catch {
    return { port, listening: false };
  }
}
