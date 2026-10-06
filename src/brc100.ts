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
const { Beef, CachedKeyDeriver, PrivateKey, normalizeBRC100WalletByteFields, stringifyBRC100 } = sdk;
const { Monitor, Services, Setup, StorageKnex, WalletStorageManager } = toolbox;

export type AgentWallet = { wallet: Wallet; identityKey: string; payAddress: string; close: () => Promise<void> };

/** Open (creating on first use) the agent account's BRC-100 wallet. Root key = the account's pay key. */
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
    close: async () => {
      await monitor.destroy().catch(() => undefined);
      await wallet.destroy().catch(() => undefined);
    },
  };
}

/**
 * Move plain BSV sitting at the account's pay address (what the app funds, what `send` spends)
 * into the BRC-100 wallet. Coins of 1 sat are left alone: they may hold ordinals or tokens.
 */
export async function fundFromPayAddress(w: AgentWallet, payWif: string) {
  const coins = (await utxos(w.payAddress)).filter((u) => u.value > 1);
  if (!coins.length) return { moved: 0, sats: 0, results: [] as { outpoint: string; success: boolean; error?: string }[] };
  const key = PrivateKey.fromWif(payWif);
  const results = await Setup.fundWalletFromP2PKHOutpoints(
    w.wallet,
    coins.map((u) => `${u.tx_hash}.${u.tx_pos}`),
    { privateKey: key, publicKey: key.toPublicKey(), address: w.payAddress } as never,
  );
  const ok = new Set(results.filter((r) => r.success).map((r) => r.outpoint));
  return { moved: ok.size, sats: coins.filter((u) => ok.has(`${u.tx_hash}.${u.tx_pos}`)).reduce((n, u) => n + u.value, 0), results };
}

export async function walletBalance(w: AgentWallet) {
  const r = await w.wallet.listOutputs({ basket: 'default', limit: 10_000 }, 'bwalletx-cli');
  return r.outputs.filter((o) => o.spendable).reduce((n, o) => n + o.satoshis, 0);
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
