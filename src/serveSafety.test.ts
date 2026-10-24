/**
 * Payment safety for `bwalletx serve` (24 Oct 2026 audit, after the x402 SDK findings):
 * per-payment cap, session budget, no wildcard origin by default, no relayable login signatures.
 * A fake wallet backend; nothing is signed or broadcast.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { P2PKH, PrivateKey } from '@bsv/sdk';

const dir = mkdtempSync(join(tmpdir(), 'bwx-serve-safety-'));
process.env.BWALLETX_HOME = dir;
const { writeConfig } = await import('./store');
const { serve, isAuthProtocolCall, hasTokenOutputs } = await import('./brc100');
const { DEFAULT_DAILY_CAP_USD, mcpMaxUsdPerCall } = await import('./store');

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function setup(origins: string[], opts: Record<string, unknown> = {}) {
  writeConfig({ accounts: { main: { name: 'main', kind: 'paired', identityAddress: '1x', payAddress: '', ordAddress: '', dailyCapUsd: null, stopped: false, importedAt: Date.now() } }, defaultAccount: 'main' } as never);
  const calls: string[] = [];
  const owned = (opts.owned as Set<string> | undefined) ?? new Set<string>();
  const w = { paired: false, call: async (m: string) => (calls.push(m), m === 'createAction' ? { txid: 'cd'.repeat(32) } : { signature: [1] }), owned: async () => owned, close: async () => undefined };
  // $50 per BSV: 1,000,000 sats = $0.50
  const server = await serve(w, { account: 'main', origins, port: 0, arc: async () => undefined, usdPerBsv: async () => 50, ...opts });
  cleanups.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (method: string, body: unknown, origin = `https://${origins[0]}`) => {
    const r = await fetch(`${url}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { post, calls };
}
const pay = (sats: number) => ({ description: 'x402 payment', outputs: [{ lockingScript: lock, satoshis: sats, outputDescription: 'pay' }] });

describe('serve payment safety', () => {
  it('refuses a payment over the per-payment cap even with no account caps set', async () => {
    const { post, calls } = await setup(['shop.example']);
    const r = await post('createAction', pay(10_000_000)); // $5 > $1 default
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/per-payment cap/);
    expect(calls).toEqual([]);
    expect((await post('createAction', pay(1_000_000))).status).toBe(200); // $0.50
  });

  it('stops at the session budget', async () => {
    const { post, calls } = await setup(['shop.example'], { maxUsdPerAction: 1, sessionBudgetUsd: 0.8 });
    expect((await post('createAction', pay(1_000_000))).status).toBe(200);
    expect((await post('createAction', pay(1_000_000))).status).toBe(400);
    expect(calls).toEqual(['createAction']);
  });

  it("refuses --origin '*' unless explicitly allowed", async () => {
    await expect(setup(['*'])).rejects.toThrow(/any web page/);
  });

  it('only signs BRC-103 login signatures when a single site is allowed', async () => {
    const auth = { protocolID: [2, 'auth message signature'], keyID: 'nonce other', counterparty: '02'.padEnd(66, 'a'), data: [1, 2] };
    const two = await setup(['a.example', 'b.example']);
    expect((await two.post('createSignature', auth)).status).toBe(400);
    expect((await two.post('createSignature', { ...auth, protocolID: [2, 'my app sig'] })).status).toBe(200);
    expect(two.calls).toEqual(['createSignature']);
    cleanups.splice(0).forEach((f) => f());
    const one = await setup(['a.example']);
    expect((await one.post('createSignature', auth)).status).toBe(200);
  });

  it('recognises the auth protocols', () => {
    expect(isAuthProtocolCall('createHmac', { protocolID: [2, 'server hmac'] })).toBe(true);
    expect(isAuthProtocolCall('createSignature', { protocolID: [2, 'Auth Message Signature '] })).toBe(true);
    expect(isAuthProtocolCall('verifySignature', { protocolID: [2, 'auth message signature'] })).toBe(false);
  });

  it('refuses token moves (inscribed outputs or the wallet\'s own named inputs) unless allowed', async () => {
    const insc = '0063036f726451' + Buffer.from('application/bsv-20').toString('hex') + '00' + Buffer.from('{"p":"bsv-20","op":"transfer","id":"x_0","amt":"1000"}').toString('hex') + '68' + lock;
    const tokenPay = { description: 'pay in tokens', outputs: [{ lockingScript: insc, satoshis: 1, outputDescription: 'tokens' }] };
    expect(hasTokenOutputs(tokenPay as never)).toBe(true);
    expect(hasTokenOutputs(pay(1) as never)).toBe(false);
    const { post, calls } = await setup(['shop.example'], { owned: new Set(['ee'.repeat(32) + '.0']) });
    const r = await post('createAction', tokenPay);
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/tokens or ordinals/);
    const named = { ...pay(1), inputs: [{ outpoint: 'ee'.repeat(32) + '.0', inputDescription: 'my token' }], inputBEEF: [1] };
    expect((await post('createAction', named)).status).toBe(400);
    expect(calls).toEqual([]);
    cleanups.splice(0).forEach((f) => f());
    const ok = await setup(['shop.example'], { allowTokenTransfers: true });
    expect((await ok.post('createAction', tokenPay)).status).toBe(200);
  });

  it('new accounts get a default daily cap; MCP per-call limit defaults to $5 and is configurable', () => {
    expect(DEFAULT_DAILY_CAP_USD).toBeGreaterThan(0);
    expect(mcpMaxUsdPerCall({})).toBe(5);
    expect(mcpMaxUsdPerCall({ BWALLETX_MCP_MAX_USD: '20' })).toBe(20);
    expect(mcpMaxUsdPerCall({ BWALLETX_MCP_MAX_USD: 'nope' })).toBe(5);
  });
});
