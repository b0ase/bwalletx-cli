// Copied from the app (src/mobile/agents/strategy.test.ts): the pure strategy tests, bun:test → vitest.
// The app's localStorage gate tests are re-done against the CLI's gate in gate.test.ts.
import { describe, expect, test } from 'vitest';
import { checkRules, exampleStrategy, paperFill, parseStrategy, STRATEGY_FORMAT, type RuleState, type StrategyRules } from './strategy';

const NOW = Date.UTC(2026, 9, 4, 12);
const st = (p: Partial<RuleState> = {}): RuleState => ({ spentTodayUsd: 0, spentTotalUsd: 0, ...p });
const rules = (p: Partial<StrategyRules> = {}): StrategyRules => ({ tokens: ['B0ASEX'], actions: ['buy'], maxPerTradeUsd: 2, ...p });

describe('strategy file', () => {
  test('the example round-trips', () => {
    const r = parseStrategy(JSON.stringify(exampleStrategy()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.strategy).toEqual(exampleStrategy());
  });

  test('missing limits are reported, not defaulted', () => {
    const r = parseStrategy({ format: STRATEGY_FORMAT, name: 'x', version: '1', goals: 'g', rules: { tokens: [], actions: ['buy', 'fly'] } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toContain('rules.tokens');
      expect(r.errors.join(' ')).toContain('maxPerTradeUsd');
    }
    expect(parseStrategy('{nope').ok).toBe(false);
  });

  test('send needs a send list; unknown fields are dropped', () => {
    const base = { format: STRATEGY_FORMAT, name: 'x', version: '1', goals: 'g', rules: { tokens: ['A'], actions: ['send'], maxPerTradeUsd: 1 } };
    expect(parseStrategy(base).ok).toBe(false);
    const r = parseStrategy({ ...base, evil: 1, rules: { ...base.rules, sendTo: ['a@bwalletx.com'], widen: true } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('evil' in r.strategy).toBe(false);
      expect('widen' in r.strategy.rules).toBe(false);
    }
  });
});

describe('rules', () => {
  test('action, token and per-trade limits', () => {
    expect(checkRules(rules(), { kind: 'buy', token: '$b0asex', usd: 2, priceUsd: 1 }, st()).ok).toBe(true);
    expect(checkRules(rules(), { kind: 'sell', token: 'B0ASEX', usd: 0 }, st())).toMatchObject({ ok: false, rule: 'actions' });
    expect(checkRules(rules(), { kind: 'buy', token: 'OTHER', usd: 1 }, st())).toMatchObject({ ok: false, rule: 'tokens' });
    expect(checkRules(rules(), { kind: 'buy', token: 'B0ASEX', usd: 2.01 }, st())).toMatchObject({ ok: false, rule: 'maxPerTradeUsd' });
    expect(checkRules(rules(), { kind: 'buy', token: 'B0ASEX', usd: -1 }, st()).ok).toBe(false);
  });

  test('day and total limits, price limits', () => {
    const r = rules({ maxPerDayUsd: 5, maxTotalUsd: 10, buyBelowUsd: 0.5 });
    expect(checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2, priceUsd: 0.4 }, st({ spentTodayUsd: 4 }))).toMatchObject({ rule: 'maxPerDayUsd' });
    expect(checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2, priceUsd: 0.4 }, st({ spentTotalUsd: 9 }))).toMatchObject({ rule: 'maxTotalUsd' });
    expect(checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2, priceUsd: 0.6 }, st())).toMatchObject({ rule: 'buyBelowUsd' });
    expect(checkRules(r, { kind: 'buy', token: 'B0ASEX', usd: 2 }, st())).toMatchObject({ rule: 'buyBelowUsd' });
    const s = rules({ actions: ['sell'], sellAboveUsd: 1 });
    expect(checkRules(s, { kind: 'sell', token: 'B0ASEX', usd: 0, priceUsd: 0.9 }, st())).toMatchObject({ rule: 'sellAboveUsd' });
    expect(checkRules(s, { kind: 'sell', token: 'B0ASEX', usd: 0, priceUsd: 1 }, st()).ok).toBe(true);
  });

  test('send list and stop conditions', () => {
    const r = rules({ actions: ['send'], sendTo: ['Bob@bwalletx.com'] });
    expect(checkRules(r, { kind: 'send', token: 'B0ASEX', usd: 1, to: 'bob@bwalletx.com' }, st()).ok).toBe(true);
    expect(checkRules(r, { kind: 'send', token: 'B0ASEX', usd: 1, to: 'eve@x.com' }, st())).toMatchObject({ rule: 'sendTo' });
    const stop = rules({ stop: { holdTokens: 100, downPct: 30 } });
    expect(checkRules(stop, { kind: 'buy', token: 'B0ASEX', usd: 1 }, st({ holding: 100 }))).toMatchObject({ rule: 'stop' });
    expect(checkRules(stop, { kind: 'buy', token: 'B0ASEX', usd: 1 }, st({ startValueUsd: 100, valueUsd: 70 }))).toMatchObject({ rule: 'stop' });
    expect(checkRules(stop, { kind: 'buy', token: 'B0ASEX', usd: 1 }, st({ startValueUsd: 100, valueUsd: 71 })).ok).toBe(true);
  });
});

describe('paper mode', () => {
  test('fills use pretend cash and holdings', () => {
    const b0 = { cashUsd: 10, tokens: {}, spentUsd: 0 };
    const b1 = paperFill(b0, { kind: 'buy', token: '$abc', usd: 4, priceUsd: 0.5 });
    expect(b1).toMatchObject({ ok: true, book: { cashUsd: 6, tokens: { ABC: 8 }, spentUsd: 4 } });
    if (!b1.ok) return;
    expect(paperFill(b1.book, { kind: 'buy', token: 'ABC', usd: 7, priceUsd: 1 }).ok).toBe(false);
    expect(paperFill(b1.book, { kind: 'sell', token: 'ABC', usd: 0, amount: 8, priceUsd: 1 })).toMatchObject({ ok: true, book: { cashUsd: 14 } });
    expect(paperFill(b1.book, { kind: 'sell', token: 'ABC', usd: 0, amount: 9, priceUsd: 1 }).ok).toBe(false);
  });
});

describe('tickers', () => {
  test('a rule naming a ticker accepts that token by id', () => {
    const id = 'a'.repeat(64) + '_0';
    expect(checkRules(rules(), { kind: 'buy', token: id, ticker: 'B0ASEX', usd: 1 }, st()).ok).toBe(true);
    expect(checkRules(rules(), { kind: 'buy', token: id, ticker: 'FAKE', usd: 1 }, st()).ok).toBe(false);
  });
});
