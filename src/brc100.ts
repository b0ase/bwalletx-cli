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
import { appendLog, home } from './store.js';
import { utxos } from './wallet.js';
import type { AgentKeys } from './keyfile.js';

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
export function outgoingSats(args: CreateActionArgs): number {
  const out = (args.outputs ?? []).reduce((n, o) => n + o.satoshis, 0);
  if (!args.inputs?.length || !args.inputBEEF) return out;
  let brought = 0;
  try {
    const beef = Beef.fromBinary(Array.from(args.inputBEEF));
    for (const i of args.inputs) {
      const [txid, vout] = i.outpoint.split('.');
      const tx = beef.findTxid(txid)?.tx;
      brought += tx?.outputs[Number(vout)]?.satoshis ?? 0;
    }
  } catch {
    return out; // unreadable BEEF: count the outputs in full
  }
  return Math.max(0, out - brought);
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

export type ServeOptions = { account: string; origins: string[]; port?: number; onEvent?: (line: string) => void };

/** Serve the agent wallet over the BRC-100 HTTP JSON substrate. Resolves once listening. */
export async function serve(w: AgentWallet, o: ServeOptions) {
  const allowed = new Set(o.origins.map(hostOf));
  const say = o.onEvent ?? (() => undefined);
  const api = w.wallet as unknown as Record<string, (args: unknown, originator?: string) => Promise<unknown>>;

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
    if (req.method !== 'POST' || !ALLOWED.has(call)) return send(res, 400, refusal(`bwalletx serve: ${call || 'this call'} is not offered`), origin);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024 * 1024) return send(res, 413, refusal('Request too large'), origin);
      chunks.push(c as Buffer);
    }
    const args = normalizeBRC100WalletByteFields(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) as Record<string, unknown>;

    if (call === 'createAction') {
      const a = args as unknown as CreateActionArgs;
      const sats = outgoingSats(a);
      const usd = sats ? (sats / 1e8) * (await bsvUsd()) : 0;
      const g = gateAction(o.account, { kind: 'send', token: 'BSV', usd, to: host });
      if (!g.ok) {
        say(`REFUSED ${host} createAction (${sats} sats): ${g.reason}`);
        return send(res, 400, refusal(`bWalletX agent refused: ${g.reason}`), origin);
      }
      if (g.paper) return send(res, 400, refusal('bWalletX agent is in paper mode: nothing is signed'), origin);
    }

    try {
      const out = await api[call](args, host);
      if (LOGGED.has(call)) {
        const a = args as { description?: string };
        const r = out as { txid?: string };
        const sats = call === 'createAction' ? outgoingSats(args as unknown as CreateActionArgs) : 0;
        const usd = sats ? (sats / 1e8) * (await bsvUsd().catch(() => 0)) : 0;
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
      if (err.name === 'WERR_INSUFFICIENT_FUNDS') return send(res, 400, { isError: true, code: 7, totalSatoshisNeeded: err.totalSatoshisNeeded, moreSatoshisNeeded: err.moreSatoshisNeeded }, origin);
      send(res, 400, refusal(err.message ?? String(e)), origin);
    }
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
