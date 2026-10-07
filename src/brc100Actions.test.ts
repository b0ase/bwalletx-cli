import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrivateKey } from '@bsv/sdk';
import { pairingStatus, serveStatus, withdrawFrom } from './brc100Actions';
import { exampleStrategy, type StrategyRules } from './strategy';
import { readLog, setAllStopped, setLoaded, writeConfig, type AccountConfig } from './store';

const NOW = Date.now();
const acct = (p: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 't', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: null, stopped: false, importedAt: NOW - 1e7, ...p,
});
const to = PrivateKey.fromRandom().toAddress(); // fresh key: never a real wallet
const fakeWallet = () => {
  const createAction = vi.fn(async () => ({ txid: 'ab'.repeat(32) }));
  return { w: { wallet: { createAction } as never, sendWaiting: vi.fn(async () => undefined) }, createAction };
};
const sendRules = (p: Partial<StrategyRules> = {}): StrategyRules => ({ tokens: ['BSV'], actions: ['send'], maxPerTradeUsd: 100, sendTo: [to], ...p });

describe('withdrawFrom: gated like send', () => {
  beforeEach(() => {
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-'));
    writeConfig({ accounts: { t: acct() }, defaultAccount: 't' });
    setAllStopped(false);
  });
  const go = (w: ReturnType<typeof fakeWallet>['w'], amount: number | 'all' = 1) => withdrawFrom('t', w, { amount, address: to, have: 10_000_000, rate: 50 });

  test('refuses when all agents are stopped, never signs', async () => {
    const { w, createAction } = fakeWallet();
    setAllStopped(true);
    await expect(go(w)).rejects.toThrow(/Refused: All agents are stopped/);
    expect(createAction).not.toHaveBeenCalled();
  });

  test('refuses over the daily cap', async () => {
    writeConfig({ accounts: { t: acct({ dailyCapUsd: 0.1 }) }, defaultAccount: 't' });
    const { w, createAction } = fakeWallet();
    await expect(go(w)).rejects.toThrow(/Refused/);
    expect(createAction).not.toHaveBeenCalled();
  });

  test('paper mode never signs', async () => {
    setLoaded('t', { strategy: { ...exampleStrategy('BSV'), rules: sendRules() }, mode: 'paper', loadedAt: NOW - 1000 });
    const { w, createAction } = fakeWallet();
    await expect(go(w)).rejects.toThrow('Paper mode: nothing is signed');
    expect(createAction).not.toHaveBeenCalled();
  });

  test('more than the wallet holds is refused', async () => {
    const { w, createAction } = fakeWallet();
    await expect(withdrawFrom('t', w, { amount: 1000, address: to, have: 10, rate: 50 })).rejects.toThrow(/Can't send/);
    expect(createAction).not.toHaveBeenCalled();
  });

  test('allowed: signs, relays and logs a send', async () => {
    const { w, createAction } = fakeWallet();
    const relay = vi.fn(async () => undefined);
    const r = await withdrawFrom('t', w, { amount: 'all', address: to, have: 10_300, rate: 50, relay });
    expect(r.sats).toBe(10_000);
    expect(createAction).toHaveBeenCalledOnce();
    expect(relay).toHaveBeenCalledOnce();
    expect(readLog('t').at(-1)).toMatchObject({ action: 'send' });
  });
});

describe('pairingStatus', () => {
  beforeEach(() => {
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-'));
    writeConfig({ accounts: { t: acct() }, defaultAccount: 't' });
  });

  test('key-file account is not paired', () => {
    expect(pairingStatus('t')).toEqual({ account: 't', paired: false, keyFile: true });
  });

  test('brc100 pairing: mode reported, secrets never returned', () => {
    const dir = join(process.env.BWALLETX_HOME!, 'paired');
    mkdirSync(dir, { recursive: true });
    const secret = 'ff'.repeat(32);
    writeFileSync(join(dir, 'main.json'), JSON.stringify({ format: 'bwalletx.pairing/1', name: 'main', c: 'chan', r: 'relay', s: secret, k: '02ab', sent: 1, lastSeen: NOW, account: 'Main', identityAddress: '1Id', scopes: ['brc100'], expiresAt: NOW - 1, pairedAt: NOW - 1e6, mode: 'brc100' }));
    const r = pairingStatus('main');
    expect(r).toMatchObject({ paired: true, mode: 'brc100 (main wallet)', expired: true, scopes: ['brc100'] });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r).not.toHaveProperty('s');
    expect(r).not.toHaveProperty('k');
  });
});

describe('serveStatus', () => {
  test('reports a listener, and none on a closed port', async () => {
    const srv = createServer((_q, res) => (res.writeHead(403), res.end()));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    expect(await serveStatus(port)).toMatchObject({ listening: true, status: 403 });
    await new Promise((r) => srv.close(r));
    expect(await serveStatus(port, 500)).toEqual({ port, listening: false });
  });
});
