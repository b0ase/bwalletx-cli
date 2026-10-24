/**
 * BRC-100 mode: an agent account as a full BRC-100 wallet (createAction, signAction, getPublicKey,
 * createSignature, listOutputs, internalizeAction…), built on @bsv/wallet-toolbox with a local
 * SQLite store at ~/.bwalletx/brc100/<account>.sqlite. Standalone accounts only: the keys are
 * decrypted from the key file into memory, never written anywhere.
 *
 * `serve` puts it on http://localhost:3321, the port BRC-100 sites already probe for a desktop
 * wallet (BSV Desktop / Metanet), so any such site can use the agent account. Guard rails:
 *   - only origins on the allowlist get an answer;
 *   - every createAction passes the same gate as `send` (kill switch, daily cap, rate limit,
 *     loaded strategy) for the BSV it would take out of the account;
 *   - every call that spends or signs is logged to ~/.bwalletx/log/<account>.jsonl.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { CreateActionArgs, WalletInterface } from '@bsv/sdk';
import type { Wallet } from '@bsv/wallet-toolbox';
import { gateAction } from './gate.js';
import { bsvUsd } from './market.js';
import { appendLog, home, withSpendLock } from './store.js';
import { utxos } from './wallet.js';
import type { AgentKeys } from './keyfile.js';
import { repairStaleProofs, type RepairResult } from './opns/proofRepair.js';
import { syncProofs, type SyncResult } from './opns/proofSync.js';

/** proven_tx_reqs statuses still waiting for a merkle proof (toolbox TaskCheckForProofs / TaskCheckNoSends). */
const UNPROVEN = ['callback', 'unmined', 'sending', 'unknown', 'unconfirmed', 'nosend'];

export const BRC100_PORT = 3321;

// The toolbox is CommonJS and checks keys against the SDK's CommonJS build, so everything handed
// to it comes from that same build (mixing in the ESM build's classes fails its instanceof checks).
const require = createRequire(import.meta.url);
const sdk = require('@bsv/sdk') as typeof import('@bsv/sdk');
const toolbox = require('@bsv/wallet-toolbox') as typeof import('@bsv/wallet-toolbox');
const { Beef, CachedKeyDeriver, KeyDeriver, PrivateKey, normalizeBRC100WalletByteFields, stringifyBRC100 } = sdk;
const { Monitor, Services, Setup, StorageKnex, WalletStorageManager } = toolbox;

export type AgentWallet = {
  wallet: Wallet;
  identityKey: string;
  payAddress: string;
  /** Broadcast whatever the wallet has queued (the toolbox sends in the background by default). */
  sendWaiting: () => Promise<void>;
  /** Run the monitor in the background (broadcasts, proofs, status) while a long-lived command runs. */
  startMonitor: () => void;
  /** Re-check stored merkle proofs against the chain and re-prove any from an orphaned block (see opns/proofRepair.ts). */
  repairProofs?: () => Promise<RepairResult>;
  /** Fetch merkle proofs for the wallet's unproven txs and mark them completed (see opns/proofSync.ts). */
  syncProofs?: () => Promise<SyncResult>;
  close: () => Promise<void>;
};

/** The storage the bWalletX app syncs every account to (1Sat Storage). */
export const SHARED_STORAGE_URL = 'https://wallet.1sat.app';

/**
 * The account's wallet exactly as the bWalletX app sees it: rooted on the account's identity key, with
 * 1Sat Storage as the active store. For the app and the CLI to share it safely, the account's active
 * storage in the app must be that remote too (Settings › Wallet Backup), not the phone's local store.
 * No local monitor: with a remote active store the storage server broadcasts and tracks proofs.
 */
export async function openSharedWallet(keys: AgentKeys, url = SHARED_STORAGE_URL): Promise<AgentWallet> {
  const rootKey = PrivateKey.fromWif(keys.identityPk);
  const keyDeriver = new CachedKeyDeriver(rootKey);
  const storage = new WalletStorageManager(keyDeriver.identityKey);
  const services = new Services('main');
  const wallet = new toolbox.Wallet({ chain: 'main', keyDeriver: keyDeriver as never, storage, services });
  await storage.addWalletStorageProvider(new toolbox.StorageClient(wallet, url));
  await storage.makeAvailable();
  return {
    wallet,
    identityKey: keyDeriver.identityKey,
    payAddress: PrivateKey.fromWif(keys.payPk).toAddress(),
    sendWaiting: async () => undefined,
    startMonitor: () => undefined,
    close: async () => {
      await wallet.destroy().catch(() => undefined);
    },
  };
}

/**
 * The CLI's original private wallet (0.3.0–0.3.3): rooted on the pay key, local SQLite. Kept so its
 * balance can be moved into the shared wallet with `brc100 migrate`.
 */
export async function openWallet(account: string, keys: AgentKeys): Promise<AgentWallet> {
  const dir = join(home(), 'brc100');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rootKey = PrivateKey.fromWif(keys.payPk);
  const keyDeriver = new CachedKeyDeriver(rootKey);
  const identityKey = keyDeriver.identityKey;
  const storage = new WalletStorageManager(identityKey);
  const services = new Services('main');
  const knex = Setup.createSQLiteKnex(join(dir, `${account.replace(/[^\w.-]/g, '_')}.sqlite`));
  const active = new StorageKnex({ chain: 'main', knex, commissionSatoshis: 0, commissionPubKeyHex: undefined, feeModel: { model: 'sat/kb', value: 100 } });
  await active.migrate(`bwalletx-${account}`, identityKey);
  await active.makeAvailable();
  await storage.addWalletStorageProvider(active);
  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions('main', storage, services));
  monitor.addDefaultTasks();
  // `as never`: same CJS class at runtime; TypeScript only sees the ESM typings for our require.
  const wallet = new toolbox.Wallet({ chain: 'main', keyDeriver: keyDeriver as never, storage, services, monitor });
  return {
    wallet,
    identityKey,
    payAddress: rootKey.toAddress(),
    sendWaiting: async () => {
      await monitor.runTask('SendWaiting').catch(() => undefined);
    },
    startMonitor: () => {
      monitor.startTasks().catch(() => undefined);
    },
    // The local monitor gets no reorg events, so proofs taken from a losing block stay put (16 Oct 2026).
    repairProofs: async () => {
      const tracker = await services.getChainTracker();
      return repairStaleProofs({
        roots: async () =>
          (await knex('proven_txs').distinct('height', 'merkleRoot').orderBy('height', 'desc')) as { height: number; merkleRoot: string }[],
        isValidRoot: (root, height) => tracker.isValidRootForHeight(root, height),
        reprove: async (height, root) => {
          const r = await storage.reproveHeightMerkleRoot(height, root);
          return { updated: r.updated.length, unavailable: r.unavailable.length + r.unchanged.length };
        },
      });
    },
    syncProofs: () =>
      syncProofs({
        unproven: async () => {
          const r = (await knex('proven_tx_reqs').whereIn('status', UNPROVEN).count({ n: '*' })) as { n: number | string }[];
          return Number(r[0]?.n ?? 0);
        },
        tip: async () => {
          const h = await monitor.chaintracks.findChainTipHeader();
          return h as unknown as { height: number; hash: string };
        },
        newHeader: (h) => monitor.processNewBlockHeader(h as never),
        runTask: (t) => monitor.runTask(t),
      }),
    close: async () => {
      await monitor.destroy().catch(() => undefined);
      await wallet.destroy().catch(() => undefined);
    },
  };
}

/**
 * The addresses the bWalletX app shows for this account: BRC-42 children of the identity key at
 * protocol [0,'onesat'] (and the older [0,'p 1sat']), keyID "1sat <n>", counterparty self, n = 0…
 * The app's receive screen shows index 0 and adds more with "new address".
 */
/** Smallest coin `fund` moves; smaller ones cost about as much in fees as they hold. */
export const FUND_MIN = 1_000;

export const DEPOSIT_PROTOCOLS: [0, string][] = [
  [0, 'onesat'],
  [0, 'p 1sat'],
];
export function appAddresses(identityWif: string, count = 10) {
  const kd = new KeyDeriver(PrivateKey.fromWif(identityWif));
  const out: { address: string; key: InstanceType<typeof PrivateKey>; label: string }[] = [];
  for (const proto of DEPOSIT_PROTOCOLS)
    for (let n = 0; n < count; n++) {
      const key = kd.derivePrivateKey(proto, `1sat ${n}`, 'self');
      out.push({ address: key.toAddress(), key, label: `app receive address ${n}${proto[1] === 'onesat' ? '' : ' (legacy)'}` });
    }
  return out;
}

/**
 * Move plain BSV into the BRC-100 wallet from the account's pay address (what `send` spends and the
 * key file names) and from the receive addresses the bWalletX app shows for it.
 * Coins of 1 sat are left alone: they may hold ordinals or tokens.
 */
export async function fundFromPayAddress(w: AgentWallet, keys: AgentKeys) {
  const pay = PrivateKey.fromWif(keys.payPk);
  const sources = [{ address: w.payAddress, key: pay, label: 'pay address' }, ...appAddresses(keys.identityPk)];
  const results: { outpoint: string; success: boolean; error?: string; from?: string }[] = [];
  let moved = 0;
  let sats = 0;
  for (const src of sources) {
    // Skip dust: below FUND_MIN a coin costs about as much to move as it holds.
    const coins = (await utxos(src.address).catch(() => [])).filter((u) => u.value >= FUND_MIN);
    if (!coins.length) continue;
    let r: { outpoint: string; success: boolean; error?: string }[];
    try {
      r = await Setup.fundWalletFromP2PKHOutpoints(
        w.wallet,
        coins.map((u) => `${u.tx_hash}.${u.tx_pos}`),
        { privateKey: src.key, publicKey: src.key.toPublicKey(), address: src.address } as never,
      );
    } catch (e) {
      // One address failing (e.g. a provider can't serve a source tx) must not block the others.
      const error = e instanceof Error ? e.message : String(e);
      results.push(...coins.map((u) => ({ outpoint: `${u.tx_hash}.${u.tx_pos}`, success: false, error, from: `${src.label} ${src.address}` })));
      continue;
    }
    const ok = new Set(r.filter((x) => x.success).map((x) => x.outpoint));
    moved += ok.size;
    sats += coins.filter((u) => ok.has(`${u.tx_hash}.${u.tx_pos}`)).reduce((n, u) => n + u.value, 0);
    results.push(...r.map((x) => ({ ...x, from: `${src.label} ${src.address}` })));
  }
  // The toolbox queues new transactions for its monitor to broadcast; send them before we return.
  if (moved) await w.sendWaiting();
  return { moved, sats, results };
}

export async function walletBalance(w: AgentWallet) {
  const r = await w.wallet.listOutputs({ basket: 'default', limit: 10_000 }, 'bwalletx-cli');
  return r.outputs.filter((o) => o.spendable).reduce((n, o) => n + o.satoshis, 0);
}

/**
 * Move everything in the old local wallet into the shared one, as a BRC-29 payment the shared wallet
 * internalizes (so it lands in its default basket, spendable by the app and the CLI alike).
 */
export async function migrateLocalToShared(local: AgentWallet, shared: AgentWallet, note: (detail: string) => void = () => undefined) {
  const have = await walletBalance(local);
  const sats = have - 300; // leave the network fee
  if (sats < FUND_MIN) return { sats: 0, txid: null as string | null };
  const derivationPrefix = sdk.Utils.toBase64(sdk.Random(8));
  const derivationSuffix = sdk.Utils.toBase64(sdk.Random(8));
  const { publicKey } = await shared.wallet.getPublicKey(
    { protocolID: [2, '3241645161d8'], keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: local.identityKey },
    'bwalletx-cli',
  );
  const lockingScript = new sdk.P2PKH().lock(sdk.PublicKey.fromString(publicKey).toAddress()).toHex();
  // Recorded before broadcasting: if internalizing fails, these recover the payment.
  note(`migrate remittance: prefix ${derivationPrefix} suffix ${derivationSuffix} sender ${local.identityKey} to ${shared.identityKey}`);
  const r = await local.wallet.createAction(
    { description: 'bwalletx: move into the shared wallet', outputs: [{ lockingScript, satoshis: sats, outputDescription: 'to the shared wallet' }], options: { acceptDelayedBroadcast: false, randomizeOutputs: false } },
    'bwalletx-cli',
  );
  if (!r.tx) throw new Error('The local wallet returned no transaction');
  await shared.wallet.internalizeAction(
    {
      tx: r.tx,
      description: 'bwalletx: moved in from the CLI wallet',
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: local.identityKey } }],
    },
    'bwalletx-cli',
  );
  return { sats, txid: r.txid ?? null };
}

/**
 * Sats a createAction takes out of the account: what its outputs carry minus what the caller's
 * own inputs (from inputBEEF, e.g. a pool's coins in a trade) bring in. The wallet's change and
 * fee are on top; the fee is small, change comes back.
 */
export function outgoingSats(args: CreateActionArgs, owned: ReadonlySet<string> = new Set()): number {
  const out = (args.outputs ?? []).reduce((n, o) => n + o.satoshis, 0);
  if (!args.inputs?.length || !args.inputBEEF) return out;
  let brought = 0;
  try {
    const beef = Beef.fromBinary(Array.from(args.inputBEEF));
    for (const i of args.inputs) {
      // The wallet's OWN coins named as inputs are not brought in by the caller: counting them would let a
      // site spend the account's balance past the cap with outgoingSats = 0 (18 Oct 2026 review).
      if (owned.has(i.outpoint)) continue;
      const [txid, vout] = i.outpoint.split('.');
      const tx = beef.findTxid(txid)?.tx;
      brought += tx?.outputs[Number(vout)]?.satoshis ?? 0;
    }
  } catch {
    return out; // unreadable BEEF: count the outputs in full
  }
  return Math.max(0, out - brought);
}

/**
 * The toolbox's default broadcasters can land a transaction at WhatsOnChain without it ever reaching
 * the miners (seen live: two agent txs sat unmined until re-sent to ARC). So everything the agent signs
 * is also handed to GorillaPool's ARC, as Extended Format when the BEEF carries the parents. Idempotent.
 */
export async function relayToArc(result: unknown, url = 'https://arc.gorillapool.io') {
  const tx = (result as { tx?: number[] } | null)?.tx;
  if (!tx?.length) return;
  const t = sdk.Transaction.fromAtomicBEEF(Array.from(tx));
  let rawTx: string;
  try {
    rawTx = t.toHexEF();
  } catch {
    rawTx = t.toHex();
  }
  await fetch(`${url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(15_000) });
}

/** Calls a site may make. Everything else (privileged key linkage, certificates) is refused. */
const ALLOWED = new Set([
  'createAction',
  'signAction',
  'abortAction',
  'listActions',
  'internalizeAction',
  'listOutputs',
  'relinquishOutput',
  'getPublicKey',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'isAuthenticated',
  'waitForAuthentication',
  'getHeight',
  'getHeaderForHeight',
  'getNetwork',
  'getVersion',
]);
const LOGGED = new Set(['createAction', 'signAction', 'internalizeAction', 'createSignature', 'relinquishOutput']);

const hostOf = (origin: string) => {
  try {
    return new URL(origin.includes('://') ? origin : `https://${origin}`).host.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
};

/** A wallet error the SDK client turns back into a proper error with our message (code 6). */
const refusal = (message: string) => ({ isError: true, code: 6, parameter: 'bwalletx', message });

/**
 * The wallet behind `serve`: the CLI's own (local or shared storage) or the owner's paired bWalletX.
 * `paired` backends sign and broadcast on the phone, so serve doesn't relay to ARC for them and only
 * forwards the calls in PAIRED_FORWARD.
 */
export type ServeWallet = {
  paired: boolean;
  call: (method: string, args: unknown, site: string) => Promise<unknown>;
  /** Outpoints ("txid.vout") the wallet itself holds as spendable BSV; inputs naming them are the account's money. */
  owned?: () => Promise<Set<string>>;
  close: () => Promise<void>;
};

export const localBackend = (w: AgentWallet): ServeWallet => {
  const api = w.wallet as unknown as Record<string, (args: unknown, originator?: string) => Promise<unknown>>;
  return {
    paired: false,
    call: (m, args, site) => api[m](args, site),
    owned: async () => {
      const r = await w.wallet.listOutputs({ basket: 'default', limit: 10_000 }, 'bwalletx-cli');
      return new Set(r.outputs.map((o) => o.outpoint));
    },
    close: () => w.close(),
  };
};

/** Phase 1 (read-only) and phase 2 (createAction/signAction: the phone prompts every time). */
export const PAIRED_FORWARD = new Set(['getPublicKey', 'listOutputs', 'isAuthenticated', 'waitForAuthentication', 'getNetwork', 'getHeight', 'getVersion', 'createAction', 'signAction']);
/** Never leave the machine, whatever the mode. */
export const NEVER_FORWARD = new Set(['revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage']);

export class WalletUnreachable extends Error {
  name = 'WalletUnreachable';
}

/**
 * Forward to the paired main wallet over the pairing relay. One connection, reopened when it drops.
 * No fallback to a local wallet: a timeout or a dead relay is a "wallet unreachable" error.
 */
export async function pairedBackend(name: string, o: { timeoutMs?: number } = {}): Promise<ServeWallet> {
  const { PhoneSession, callBrc100 } = await import('./paired.js');
  let session: import('./paired.js').PhoneSession | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const one = async (method: string, args: unknown, site: string) => {
    try {
      if (!session?.isOpen) session = await PhoneSession.open(name);
    } catch (e) {
      throw new WalletUnreachable(`wallet unreachable: ${(e as Error).message}`);
    }
    try {
      return await callBrc100(name, method, args, site, { session, timeoutMs: o.timeoutMs });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code) throw err; // the phone answered (refused, cap, user said no)
      throw new WalletUnreachable(`wallet unreachable: ${err.message}`);
    }
  };
  return {
    paired: true,
    // Serialised: one sealed request at a time keeps the counters and the relay's rate limit happy.
    call: (method, args, site) => {
      const r = queue.then(() => one(method, args, site));
      queue = r.catch(() => undefined);
      return r;
    },
    close: async () => session?.close(),
  };
}

export type ServeOptions = {
  account: string;
  origins: string[];
  port?: number;
  onEvent?: (line: string) => void;
  /** For tests: what is called to hand a signed tx to ARC (local mode only). */
  arc?: (result: unknown) => Promise<void>;
  /** For tests: BSV price instead of fetching it. */
  usdPerBsv?: () => Promise<number>;
  /** Most one createAction may move, in USD, whatever the account's own caps say. Default SERVE_MAX_USD_PER_ACTION. */
  maxUsdPerAction?: number;
  /** Most this serve session may move in total, in USD. Default SERVE_SESSION_BUDGET_USD. */
  sessionBudgetUsd?: number;
  /** Allow `--origin '*'` (any web page on this machine can drive the wallet). Off by default. */
  allowAnyOrigin?: boolean;
};

/**
 * Defaults for automatic payments from sites (24 Oct 2026 audit, after the x402 SDK findings): an account
 * with no daily cap and no approval threshold must not be drainable by one 402 asking for everything.
 */
export const SERVE_MAX_USD_PER_ACTION = 1;
export const SERVE_SESSION_BUDGET_USD = 5;

/**
 * BRC-103/104 mutual-auth signatures and nonces. Keys are derived per counterparty, not per site, so an
 * allowed site could ask for a login signature addressed to ANOTHER site's server and relay it. Those are
 * only signed when serve allows a single origin, so the requester is the only site the login can be for.
 */
const AUTH_PROTOCOLS = new Set(['auth message signature', 'server hmac']);
export const isAuthProtocolCall = (call: string, args: unknown) => {
  if (!['createSignature', 'createHmac'].includes(call)) return false;
  const p = (args as { protocolID?: unknown } | null)?.protocolID;
  return Array.isArray(p) && typeof p[1] === 'string' && AUTH_PROTOCOLS.has(p[1].trim().toLowerCase());
};

/** Serve a wallet over the BRC-100 HTTP JSON substrate. Resolves once listening. */
export async function serve(input: AgentWallet | ServeWallet, o: ServeOptions) {
  const w: ServeWallet = 'call' in input ? input : localBackend(input);
  const allowed = new Set(o.origins.map(hostOf));
  if (allowed.has('*') && !o.allowAnyOrigin) throw new Error("bwalletx serve: --origin '*' lets any web page spend from this wallet; name the sites instead (or pass --allow-any-origin)");
  const maxPerAction = o.maxUsdPerAction ?? SERVE_MAX_USD_PER_ACTION;
  const budget = o.sessionBudgetUsd ?? SERVE_SESSION_BUDGET_USD;
  let sessionSpentUsd = 0;
  const singleSite = allowed.size === 1 && !allowed.has('*');
  const say = o.onEvent ?? (() => undefined);
  const arc = o.arc ?? relayToArc;
  const price = o.usdPerBsv ?? bsvUsd;

  const send = (res: ServerResponse, status: number, body: unknown, origin?: string) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...(origin && { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }),
    });
    res.end(stringifyBRC100(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? req.headers.originator ?? '');
    const host = hostOf(origin);
    const ok = host && (allowed.has(host) || allowed.has('*'));
    if (req.method === 'OPTIONS') {
      res.writeHead(ok ? 204 : 403, {
        ...(ok && {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Originator',
          'Access-Control-Allow-Private-Network': 'true',
          Vary: 'Origin',
        }),
      });
      return res.end();
    }
    if (!ok) {
      say(`refused ${host || '(no origin)'}: not on the allowlist`);
      return send(res, 403, refusal(`bwalletx serve: ${host || 'this origin'} is not allowed (start with --origin ${host || '<site>'})`));
    }
    const call = (req.url ?? '').replace(/^\/+/, '').split('?')[0];
    if (req.method !== 'POST' || !ALLOWED.has(call) || NEVER_FORWARD.has(call) || (w.paired && !PAIRED_FORWARD.has(call))) return send(res, 400, refusal(`bwalletx serve: ${call || 'this call'} is not offered`), origin);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024 * 1024) return send(res, 413, refusal('Request too large'), origin);
      chunks.push(c as Buffer);
    }
    let args: Record<string, unknown>;
    try {
      args = normalizeBRC100WalletByteFields(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) as Record<string, unknown>;
    } catch {
      return send(res, 400, refusal('bwalletx serve: bad JSON'), origin);
    }
    if (w.paired && args && typeof args === 'object' && args.privileged === true) {
      say(`refused ${host} ${call}: privileged calls are never forwarded`);
      return send(res, 400, refusal('bwalletx serve: privileged calls are not offered'), origin);
    }

    // createAction/signAction: gate → sign → log under the account's spend lock, so parallel requests
    // (or another process on the same account) can't all pass the daily cap before any is logged.
    const spends = call === 'createAction' || call === 'signAction';
    return spends ? withSpendLock(o.account, () => runAndRefund(res, call, args, host, origin)) : run(res, call, args, host, origin);
  };

  const run = async (res: ServerResponse, call: string, args: Record<string, unknown>, host: string, origin: string) => {
    let sats = 0;
    if (isAuthProtocolCall(call, args) && !singleSite) {
      say(`refused ${host} ${call}: login signatures need serve to allow exactly one site`);
      return send(res, 400, refusal('bwalletx serve: login (BRC-103) signatures are only made when one site is allowed; restart with a single --origin'), origin);
    }
    if (call === 'createAction') {
      const a = args as unknown as CreateActionArgs;
      const owned = a.inputs?.length && w.owned ? await w.owned().catch(() => null) : new Set<string>();
      if (!owned) return send(res, 503, refusal('bwalletx serve: could not read the wallet to check inputs; try again'), origin);
      sats = outgoingSats(a, owned);
      const usd = sats ? (sats / 1e8) * (await price()) : 0;
      if (usd > maxPerAction + 1e-9) {
        say(`REFUSED ${host} createAction (${sats} sats, $${usd.toFixed(2)}): over the $${maxPerAction} per-payment cap`);
        return send(res, 400, refusal(`bWalletX agent refused: $${usd.toFixed(2)} is over the $${maxPerAction} per-payment cap for sites`), origin);
      }
      if (sessionSpentUsd + usd > budget + 1e-9) {
        say(`REFUSED ${host} createAction (${sats} sats): session budget $${budget} used`);
        return send(res, 400, refusal(`bWalletX agent refused: this serve session's $${budget} budget is used ($${sessionSpentUsd.toFixed(2)} spent)`), origin);
      }
      const g = gateAction(o.account, { kind: 'send', token: 'BSV', usd, to: host });
      if (!g.ok) {
        say(`REFUSED ${host} createAction (${sats} sats): ${g.reason}`);
        return send(res, 400, refusal(`bWalletX agent refused: ${g.reason}`), origin);
      }
      if (g.paper) return send(res, 400, refusal('bWalletX agent is in paper mode: nothing is signed'), origin);
      sessionSpentUsd += usd; // reserved under the spend lock; a failed sign below gives it back
    }

    try {
      const out = await w.call(call, args, host);
      // The phone broadcasts what it signs; only the CLI's own wallet needs the ARC nudge.
      if (!w.paired && (call === 'createAction' || call === 'signAction')) arc(out).catch(() => undefined);
      if (LOGGED.has(call)) {
        const a = args as { description?: string };
        const r = out as { txid?: string };
        const usd = sats ? (sats / 1e8) * (await price().catch(() => 0)) : 0;
        appendLog(o.account, {
          at: Date.now(),
          action: call === 'createAction' ? (sats ? 'send' : 'sign') : `brc100-${call}`,
          detail: `${host}: ${call}${a.description ? ` "${a.description}"` : ''}${r?.txid ? ` ${r.txid}` : ''}${sats ? ` (${sats} sats)` : ''}`,
          usd,
        });
        say(`${host} ${call}${a.description ? `: ${a.description}` : ''}${r?.txid ? ` → ${r.txid}` : ''}`);
      }
      send(res, 200, out ?? {}, origin);
    } catch (e) {
      const err = e as { code?: number; message?: string; name?: string } & Record<string, unknown>;
      say(`${host} ${call} failed: ${err.message ?? String(e)}`);
      if (err.name === 'WalletUnreachable') return send(res, 503, refusal(`bWalletX: ${err.message}`), origin);
      if (err.name === 'WERR_INSUFFICIENT_FUNDS') return send(res, 400, { isError: true, code: 7, totalSatoshisNeeded: err.totalSatoshisNeeded, moreSatoshisNeeded: err.moreSatoshisNeeded }, origin);
      send(res, 400, refusal(err.message ?? String(e)), origin);
    }
  };
  const runAndRefund = async (res: ServerResponse, call: string, args: Record<string, unknown>, host: string, origin: string) => {
    const before = sessionSpentUsd;
    await run(res, call, args, host, origin);
    if (res.statusCode !== 200 && sessionSpentUsd > before) sessionSpentUsd = before;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, refusal(e instanceof Error ? e.message : String(e))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? BRC100_PORT, '127.0.0.1', () => resolve());
  });
  return server;
}

export type { WalletInterface };
