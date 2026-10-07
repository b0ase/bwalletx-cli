/**
 * "One wallet": serve --wallet paired forwards BRC-100 calls to the paired phone over the relay.
 * In-process relay + a fake phone that decrypts and answers. Fresh random keys only; nothing broadcast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { PrivateKey } from '@bsv/sdk';
import { Sealer, deriveSession, isSealed, newChannel, type PairMessage } from './pair/protocol';

const dir = mkdtempSync(join(tmpdir(), 'bwx-one-wallet-'));
process.env.BWALLETX_HOME = dir;

const { writeConfig, writeJsonFile } = await import('./store');
const { serve, pairedBackend } = await import('./brc100');
const { CLI_ORIGIN } = await import('./paired');

/** Minimal relay: one site + one wallet socket per channel, frames forwarded verbatim (queued if the peer is away). */
function startRelay() {
  const chans = new Map<string, { site?: WebSocket; wallet?: WebSocket; q: { site: string[]; wallet: string[] }; origin?: string }>();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url ?? '', 'http://relay');
    const id = u.pathname.split('/').pop()!;
    const role = u.searchParams.get('role') as 'site' | 'wallet';
    const ch = chans.get(id) ?? { q: { site: [], wallet: [] } };
    if (role === 'site') ch.origin = String(req.headers.origin);
    chans.set(id, ch);
    wss.handleUpgrade(req, sock, head, (ws) => {
      ch[role] = ws;
      const other = role === 'site' ? 'wallet' : 'site';
      for (const f of ch.q[role].splice(0)) ws.send(f);
      ws.on('message', (raw) => {
        const peer = ch[other];
        if (peer?.readyState === WebSocket.OPEN) peer.send(String(raw));
        else ch.q[other].push(String(raw));
      });
      ws.on('close', () => ch[role] === ws && delete ch[role]);
    });
  });
  return new Promise<{ server: Server; host: string; chans: typeof chans }>((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, host: `127.0.0.1:${(server.address() as AddressInfo).port}`, chans })),
  );
}

type Seen = { method: string; args: unknown; site: string };
/** The phone: joins as wallet, decrypts requests, answers brc100 calls (or stays silent). */
async function startPhone(host: string, c: string, cliPub: string, phoneKey: PrivateKey, mode: 'answer' | 'silent') {
  const { key } = await deriveSession(phoneKey, cliPub, c);
  const sealer = new Sealer(key, 'wallet');
  const seen: Seen[] = [];
  const ws = new WebSocket(`ws://${host}/v1/c/${c}?role=wallet`);
  await new Promise((r) => ws.once('open', r));
  ws.on('message', async (raw) => {
    const f = JSON.parse(String(raw));
    if (!isSealed(f)) return;
    const msg = (await sealer.open(f)) as PairMessage | null;
    if (!msg || msg.t !== 'req' || msg.action !== 'brc100') return;
    const p = msg.params as Seen;
    seen.push(p);
    if (mode === 'silent') return;
    const result = p.method === 'getPublicKey' ? { publicKey: phoneKey.toPublicKey().toString() } : p.method === 'createAction' ? { txid: 'ab'.repeat(32), tx: [1, 2, 3] } : { ok: true };
    ws.send(JSON.stringify(await sealer.seal({ t: 'res', id: msg.id, result })));
  });
  return { seen, close: () => ws.close() };
}

let relay: Awaited<ReturnType<typeof startRelay>>;
const cleanups: (() => unknown)[] = [];

beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => {
  relay.server.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

async function setup(mode: 'answer' | 'silent', timeoutMs?: number) {
  const cli = PrivateKey.fromRandom();
  const phone = PrivateKey.fromRandom();
  const c = newChannel();
  writeJsonFile(join(dir, 'paired', 'main.json'), {
    format: 'bwalletx.pairing/1', name: 'main', c, r: relay.host, s: cli.toHex(), k: phone.toPublicKey().toString(),
    sent: 0, lastSeen: 0, account: 'Main', identityAddress: phone.toAddress(), scopes: ['wallet'],
    expiresAt: Date.now() + 86_400_000, pairedAt: Date.now(), mode: 'brc100', caps: { dailyUsd: 5 },
  });
  writeConfig({ accounts: { main: { name: 'main', kind: 'paired', identityAddress: phone.toAddress(), payAddress: '', ordAddress: '', dailyCapUsd: null, stopped: false, importedAt: Date.now() } }, defaultAccount: 'main' } as never);
  const fake = await startPhone(relay.host, c, cli.toPublicKey().toString(), phone, mode);
  const w = await pairedBackend('main', { timeoutMs });
  const arcCalls: unknown[] = [];
  const server = await serve(w, { account: 'main', origins: ['good.example'], port: 0, arc: async (r) => void arcCalls.push(r), usdPerBsv: async () => 50 });
  cleanups.push(() => fake.close(), () => w.close(), () => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (method: string, body: unknown, origin = 'https://good.example') => {
    const r = await fetch(`${url}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { post, fake, phone, arcCalls };
}

describe('serve --wallet paired', () => {
  it('forwards read-only and createAction calls to the phone (as the CLI origin), no ARC relay', async () => {
    const { post, fake, phone, arcCalls } = await setup('answer');
    const pk = await post('getPublicKey', { identityKey: true });
    expect(pk.status).toBe(200);
    expect(pk.body.publicKey).toBe(phone.toPublicKey().toString());
    const ca = await post('createAction', { description: 'a test', outputs: [] });
    expect(ca.status).toBe(200);
    expect(ca.body.txid).toBe('ab'.repeat(32));
    expect(fake.seen.map((s) => [s.method, s.site])).toEqual([['getPublicKey', 'good.example'], ['createAction', 'good.example']]);
    expect(relay.chans.size).toBeGreaterThan(0);
    expect([...relay.chans.values()].some((c) => c.origin === CLI_ORIGIN)).toBe(true);
    expect(arcCalls).toEqual([]);
  });

  it('refuses disallowed origins locally', async () => {
    const { post, fake } = await setup('answer');
    const r = await post('getPublicKey', { identityKey: true }, 'https://evil.example');
    expect(r.status).toBe(403);
    expect(fake.seen).toEqual([]);
  });

  it('refuses privileged, linkage and out-of-phase calls locally', async () => {
    const { post, fake } = await setup('answer');
    expect((await post('getPublicKey', { identityKey: true, privileged: true })).status).toBe(400);
    expect((await post('revealCounterpartyKeyLinkage', { counterparty: '02', verifier: '02' })).status).toBe(400);
    expect((await post('revealSpecificKeyLinkage', {})).status).toBe(400);
    expect((await post('createSignature', { data: [1] })).status).toBe(400);
    expect(fake.seen).toEqual([]);
  });

  it('answers "wallet unreachable" when the phone does not reply in time (no local fallback)', async () => {
    const { post, fake } = await setup('silent', 600);
    const r = await post('getPublicKey', { identityKey: true });
    expect(r.status).toBe(503);
    expect(r.body.isError).toBe(true);
    expect(String(r.body.message)).toMatch(/wallet unreachable/);
    expect(fake.seen.length).toBe(1);
  });
});
