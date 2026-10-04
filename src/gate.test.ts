import { beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGate, gateAction, rateLimited, RATE_LIMIT_PER_HOUR, type GateInput } from './gate';
import { exampleStrategy, PAPER_START_USD, type AgentLogEntry, type Loaded, type StrategyRules } from './strategy';
import { getPaper, readLog, setAllStopped, setLoaded, writeConfig, type AccountConfig } from './store';

const NOW = Date.UTC(2026, 9, 4, 12);
const acct = (p: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 't', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: null, stopped: false, importedAt: NOW - 1e7, ...p,
});
const rules = (p: Partial<StrategyRules> = {}): StrategyRules => ({ tokens: ['ABC'], actions: ['buy'], maxPerTradeUsd: 2, ...p });
const loaded = (mode: Loaded['mode'], r = rules()): Loaded => ({ strategy: { ...exampleStrategy('ABC'), rules: r }, mode, loadedAt: NOW - 1000 });
const book = () => ({ cashUsd: PAPER_START_USD, tokens: {}, spentUsd: 0 });
const input = (p: Partial<GateInput> = {}): GateInput => ({
  account: acct(), stopAll: false, log: [], loaded: null, book: book(), action: { kind: 'buy', token: 'ABC', usd: 1, priceUsd: 0.1 }, now: NOW, ...p,
});
const spend = (at: number, usd = 1, action = 'buy'): AgentLogEntry => ({ at, action, detail: '', usd });

describe('gate order: stop → daily cap → rate limit → rules', () => {
  test('kill switch and account stop', () => {
    expect(evaluateGate(input({ stopAll: true }))).toMatchObject({ ok: false, rule: 'stop', reason: 'All agents are stopped' });
    expect(evaluateGate(input({ account: acct({ stopped: true }) }))).toMatchObject({ ok: false, rule: 'stop' });
    expect(evaluateGate(input({ account: null }))).toMatchObject({ ok: false, reason: 'Not an agent account' });
  });

  test('daily cap counts live spend today only', () => {
    const a = acct({ dailyCapUsd: 5 });
    expect(evaluateGate(input({ account: a, log: [spend(NOW - 10, 4.5)] }))).toMatchObject({ ok: false, rule: 'dailyCap' });
    expect(evaluateGate(input({ account: a, log: [spend(NOW - 86_400_000, 4.5)] })).ok).toBe(true);
    // paper actions spend nothing real, so the cap never blocks them
    expect(evaluateGate(input({ account: a, log: [spend(NOW - 10, 5)], loaded: loaded('paper') })).ok).toBe(true);
  });

  test('strategy rules refuse with the rule name and a log entry', () => {
    const r = evaluateGate(input({ loaded: loaded('live', rules({ buyBelowUsd: 0.05 })) }));
    expect(r).toMatchObject({ ok: false, rule: 'buyBelowUsd', logEntry: { action: 'refused', rule: 'buyBelowUsd', usd: 0 } });
    expect(evaluateGate(input({ loaded: loaded('live') }))).toEqual({ ok: true, paper: false });
    expect(evaluateGate(input({ loaded: loaded('live'), action: { kind: 'send', token: 'BSV', usd: 1, to: 'x@y.z' } }))).toMatchObject({ rule: 'actions' });
  });

  test('live spend since load counts toward maxTotalUsd', () => {
    const l = loaded('live', rules({ maxTotalUsd: 3 }));
    expect(evaluateGate(input({ loaded: l, log: [spend(NOW - 500, 2.5)] }))).toMatchObject({ ok: false, rule: 'maxTotalUsd' });
    expect(evaluateGate(input({ loaded: l, log: [spend(NOW - 5000, 2.5)] })).ok).toBe(true); // before load
  });
});

describe('rate limit', () => {
  test(`at most ${RATE_LIMIT_PER_HOUR} spending actions per hour, paper and failed included`, () => {
    const log = Array.from({ length: RATE_LIMIT_PER_HOUR - 1 }, (_, i) => spend(NOW - i * 1000, 0, i % 2 ? 'paper-buy' : 'failed'));
    expect(rateLimited(log, NOW)).toBe(false);
    expect(rateLimited([...log, { at: NOW, action: 'refused', detail: '', usd: 0 }], NOW)).toBe(false);
    const full = [...log, spend(NOW - 5)];
    expect(rateLimited(full, NOW)).toBe(true);
    expect(evaluateGate(input({ log: full }))).toMatchObject({ ok: false, rule: 'rateLimit' });
    expect(rateLimited(full, NOW + 3_600_000 + 1000 * RATE_LIMIT_PER_HOUR)).toBe(false);
  });
});

describe('paper book', () => {
  test('fills on a $100 book and never asks to sign', () => {
    const r = evaluateGate(input({ loaded: loaded('paper'), action: { kind: 'buy', token: 'ABC', usd: 2, priceUsd: 0.1 } }));
    expect(r).toMatchObject({ ok: true, paper: true, book: { cashUsd: 98, tokens: { ABC: 20 }, spentUsd: 2 }, logEntry: { action: 'paper-buy', usd: 0 } });
  });

  test('paper stop.holdTokens uses the book', () => {
    const l = loaded('paper', rules({ stop: { holdTokens: 10 } }));
    expect(evaluateGate(input({ loaded: l, book: { cashUsd: 50, tokens: { ABC: 10 }, spentUsd: 50 } }))).toMatchObject({ ok: false, rule: 'stop' });
  });
});

describe('gateAction with stored state', () => {
  beforeEach(() => {
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-'));
    writeConfig({ accounts: { t: acct() }, defaultAccount: 't' });
  });

  test('persists paper fills and refusals to the JSONL log; kill switch file blocks', () => {
    setLoaded('t', loaded('paper', rules({ maxTotalUsd: 5 })));
    for (let i = 0; i < 2; i++) expect(gateAction('t', { kind: 'buy', token: 'ABC', usd: 2, priceUsd: 0.1 }, {}, NOW)).toMatchObject({ ok: true, paper: true });
    expect(getPaper('t')).toMatchObject({ cashUsd: 96, tokens: { ABC: 40 } });
    expect(gateAction('t', { kind: 'buy', token: 'ABC', usd: 2, priceUsd: 0.1 }, {}, NOW)).toMatchObject({ ok: false, rule: 'maxTotalUsd' });
    setAllStopped(true);
    expect(gateAction('t', { kind: 'buy', token: 'ABC', usd: 1, priceUsd: 0.1 }, {}, NOW)).toMatchObject({ ok: false, reason: 'All agents are stopped' });
    setAllStopped(false);
    expect(readLog('t').map((e) => e.action)).toEqual(['paper-buy', 'paper-buy', 'refused', 'refused']);
    expect(gateAction('nobody', { kind: 'buy', token: 'ABC', usd: 1 }, {}, NOW).ok).toBe(false);
  });
});
