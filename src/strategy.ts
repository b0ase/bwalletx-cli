/**
 * Strategies (bwalletx.strategy/1). COPIED from the app (yours-mobile-bcorp
 * src/mobile/agents/strategy.ts + the pure parts of agentAccounts.ts) with storage removed.
 * Keep these functions byte-for-byte in behaviour with the app: the same file must be refused
 * or allowed the same way everywhere. Nothing here signs or touches disk.
 */

// ---- from agentAccounts.ts (pure parts) -------------------------------------------------------
export type AgentAccount = {
  identityAddress: string;
  labels: string[];
  stopped: boolean;
  /** Most an agent may spend from this account per UTC day, in USD. null = no cap (the balance is the limit). */
  dailyCapUsd: number | null;
  createdAt: number;
};

export type AgentLogEntry = {
  at: number;
  /** What the agent did: 'send', 'buy', 'sell', 'list', 'mint', 'sweep', 'fund', 'stop', 'resume'… */
  action: string;
  detail: string;
  /** Dollars spent by this action (0 for non-spending actions). */
  usd: number;
  txid?: string;
  /** Which strategy rule caused it, once strategies exist (§3). */
  rule?: string;
};
export const dayStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Dollars agents have spent from this account today (UTC). */
export const spentToday = (log: AgentLogEntry[], now = Date.now()) =>
  log.filter((e) => e.at >= dayStart(now)).reduce((sum, e) => sum + (e.usd > 0 ? e.usd : 0), 0);

export type SpendCheck = { ok: true } | { ok: false; reason: string };

/**
 * The gate for every agent action that spends: not an agent account, stopped, or over the daily cap → refused.
 * Pure over its inputs so it is unit-tested; `checkAgentSpend` reads the stored state.
 */
export const spendAllowed = (
  account: AgentAccount | null,
  stopAll: boolean,
  log: AgentLogEntry[],
  usd: number,
  now = Date.now(),
): SpendCheck => {
  if (!account) return { ok: false, reason: 'Not an agent account' };
  if (stopAll) return { ok: false, reason: 'All agents are stopped' };
  if (account.stopped) return { ok: false, reason: 'This agent account is stopped' };
  if (account.dailyCapUsd !== null) {
    const left = account.dailyCapUsd - spentToday(log, now);
    if (usd > left + 1e-9) return { ok: false, reason: `Over today's cap ($${Math.max(0, left).toFixed(2)} left of $${account.dailyCapUsd})` };
  }
  return { ok: true };
};


// ---- from strategy.ts -----------------------------------------------------------------------

export const STRATEGY_FORMAT = 'bwalletx.strategy/1';

export type StrategyAction = 'buy' | 'sell' | 'send' | 'list';
const ACTIONS: StrategyAction[] = ['buy', 'sell', 'send', 'list'];

export type StrategyRules = {
  /** Token tickers or BSV-21 ids the agent may touch. Required: a strategy never means "any token". */
  tokens: string[];
  /** Which kinds of action are allowed. */
  actions: StrategyAction[];
  /** Buy only when the token's price (USD per token) is at or below this. */
  buyBelowUsd?: number;
  /** Sell or list only at or above this price (USD per token). */
  sellAboveUsd?: number;
  /** Most one action may spend, in USD. Required. */
  maxPerTradeUsd: number;
  /** Most per UTC day, in USD (on top of the account's own daily cap). */
  maxPerDayUsd?: number;
  /** Most in total while this strategy is loaded, in USD. */
  maxTotalUsd?: number;
  /** Sends only to these addresses / paymails. Required when "send" is allowed. */
  sendTo?: string[];
  /** Stop conditions: once met, every action is refused until the strategy is reloaded. */
  stop?: { holdTokens?: number; downPct?: number };
};

export type StrategySpec = {
  trades?: string;
  risk?: 'Low' | 'Medium' | 'High' | 'Experimental';
  spends?: string;
  often?: string;
  stops?: string;
  needs?: string;
};

export type Strategy = {
  format: typeof STRATEGY_FORMAT;
  name: string;
  version: string;
  goals: string;
  rules: StrategyRules;
  spec?: StrategySpec;
  changelog?: { version: string; note: string }[];
};

export type Parsed = { ok: true; strategy: Strategy } | { ok: false; errors: string[] };

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const strs = (v: unknown, max = 50) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean))].slice(0, max) : [];

/** Validate a strategy file (text or object). Unknown fields are dropped, so a loaded strategy only holds what the wallet understands. */
export const parseStrategy = (input: string | unknown): Parsed => {
  let o: Record<string, unknown>;
  try {
    o = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>;
  } catch {
    return { ok: false, errors: ['Not valid JSON'] };
  }
  if (!o || typeof o !== 'object') return { ok: false, errors: ['Not a strategy file'] };
  const errors: string[] = [];
  if (o.format !== STRATEGY_FORMAT) errors.push(`format must be "${STRATEGY_FORMAT}"`);
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
  if (!name) errors.push('name is required');
  const version = typeof o.version === 'string' ? o.version.trim().slice(0, 20) : '';
  if (!version) errors.push('version is required (e.g. "1.0")');
  const goals = typeof o.goals === 'string' ? o.goals.trim().slice(0, 4000) : '';
  if (!goals) errors.push('goals are required');
  const r = (o.rules ?? {}) as Record<string, unknown>;
  const tokens = strs(r.tokens);
  if (!tokens.length) errors.push('rules.tokens must list at least one token');
  const actions = strs(r.actions).filter((a): a is StrategyAction => ACTIONS.includes(a as StrategyAction));
  if (!actions.length) errors.push(`rules.actions must include one of: ${ACTIONS.join(', ')}`);
  if (!num(r.maxPerTradeUsd)) errors.push('rules.maxPerTradeUsd must be a positive number');
  for (const k of ['buyBelowUsd', 'sellAboveUsd', 'maxPerDayUsd', 'maxTotalUsd'] as const)
    if (r[k] !== undefined && !num(r[k])) errors.push(`rules.${k} must be a positive number`);
  const sendTo = strs(r.sendTo);
  if (actions.includes('send') && !sendTo.length) errors.push('rules.sendTo must list who it may send to when "send" is allowed');
  const s = (r.stop ?? {}) as Record<string, unknown>;
  if (s.holdTokens !== undefined && !num(s.holdTokens)) errors.push('rules.stop.holdTokens must be a positive number');
  if (s.downPct !== undefined && !(num(s.downPct) && (s.downPct as number) < 100)) errors.push('rules.stop.downPct must be between 0 and 100');
  if (errors.length) return { ok: false, errors };

  const opt = (k: string) => (num(r[k]) ? (r[k] as number) : undefined);
  const stop = { holdTokens: num(s.holdTokens) ? (s.holdTokens as number) : undefined, downPct: num(s.downPct) ? (s.downPct as number) : undefined };
  const rules: StrategyRules = {
    tokens,
    actions,
    maxPerTradeUsd: r.maxPerTradeUsd as number,
    ...(opt('buyBelowUsd') !== undefined && { buyBelowUsd: opt('buyBelowUsd') }),
    ...(opt('sellAboveUsd') !== undefined && { sellAboveUsd: opt('sellAboveUsd') }),
    ...(opt('maxPerDayUsd') !== undefined && { maxPerDayUsd: opt('maxPerDayUsd') }),
    ...(opt('maxTotalUsd') !== undefined && { maxTotalUsd: opt('maxTotalUsd') }),
    ...(sendTo.length && { sendTo }),
    ...((stop.holdTokens || stop.downPct) && { stop }),
  };
  const sp = (o.spec ?? {}) as Record<string, unknown>;
  const spec: StrategySpec = {};
  for (const k of ['trades', 'spends', 'often', 'stops', 'needs'] as const) if (typeof sp[k] === 'string') spec[k] = (sp[k] as string).slice(0, 200);
  if (['Low', 'Medium', 'High', 'Experimental'].includes(sp.risk as string)) spec.risk = sp.risk as StrategySpec['risk'];
  const changelog = Array.isArray(o.changelog)
    ? (o.changelog as { version?: unknown; note?: unknown }[])
        .filter((c) => typeof c?.version === 'string' && typeof c?.note === 'string')
        .slice(0, 50)
        .map((c) => ({ version: (c.version as string).slice(0, 20), note: (c.note as string).slice(0, 200) }))
    : undefined;
  return { ok: true, strategy: { format: STRATEGY_FORMAT, name, version, goals, rules, spec, ...(changelog?.length && { changelog }) } };
};

/** A request from an agent, checked before anything is signed. */
export type ActionRequest = {
  kind: StrategyAction;
  token: string;
  /** The token's ticker, when `token` is an id: rules may name either. */
  ticker?: string;
  /** Dollars this action spends (buy: cost; send: value sent; sell/list: 0). */
  usd: number;
  /** Current price, USD per token (buy / sell / list). */
  priceUsd?: number;
  /** Tokens bought, sold, sent or listed. */
  amount?: number;
  /** Recipient for send. */
  to?: string;
};

/** What the rules need to know about the account right now. */
export type RuleState = {
  spentTodayUsd: number;
  spentTotalUsd: number;
  /** Tokens of the strategy's coins held now (for stop.holdTokens). */
  holding?: number;
  /** Account value now vs when the strategy was loaded, USD (for stop.downPct). */
  valueUsd?: number;
  startValueUsd?: number;
};

export type RuleCheck = { ok: true } | { ok: false; reason: string; rule: string };

const same = (a: string, b: string) => a.replace(/^\$/, '').toLowerCase() === b.replace(/^\$/, '').toLowerCase();

/** Is the strategy's stop condition met? */
export const stopMet = (rules: StrategyRules, st: RuleState): string | null => {
  if (rules.stop?.holdTokens && (st.holding ?? 0) >= rules.stop.holdTokens) return `holds ${rules.stop.holdTokens} tokens`;
  if (rules.stop?.downPct && st.startValueUsd && st.valueUsd !== undefined && st.startValueUsd > 0) {
    const down = ((st.startValueUsd - st.valueUsd) / st.startValueUsd) * 100;
    if (down >= rules.stop.downPct) return `down ${rules.stop.downPct}%`;
  }
  return null;
};

/** The strategy half of the gate: is this action inside the rules? Pure, so it is unit-tested. */
export const checkRules = (rules: StrategyRules, a: ActionRequest, st: RuleState): RuleCheck => {
  const no = (rule: string, reason: string): RuleCheck => ({ ok: false, rule, reason });
  const stopped = stopMet(rules, st);
  if (stopped) return no('stop', `Strategy finished: ${stopped}`);
  if (!rules.actions.includes(a.kind)) return no('actions', `"${a.kind}" isn't allowed by this strategy`);
  if (!rules.tokens.some((t) => same(t, a.token) || (a.ticker && same(t, a.ticker)))) return no('tokens', `${a.ticker ?? a.token} isn't one of this strategy's tokens`);
  if (!(a.usd >= 0) || !Number.isFinite(a.usd)) return no('maxPerTradeUsd', 'Invalid amount');
  if (a.usd > rules.maxPerTradeUsd + 1e-9) return no('maxPerTradeUsd', `$${a.usd.toFixed(2)} is over the $${rules.maxPerTradeUsd} per-trade limit`);
  if (rules.maxPerDayUsd !== undefined && st.spentTodayUsd + a.usd > rules.maxPerDayUsd + 1e-9)
    return no('maxPerDayUsd', `Over the strategy's $${rules.maxPerDayUsd}/day limit`);
  if (rules.maxTotalUsd !== undefined && st.spentTotalUsd + a.usd > rules.maxTotalUsd + 1e-9)
    return no('maxTotalUsd', `Over the strategy's $${rules.maxTotalUsd} total limit`);
  if (a.kind === 'buy' && rules.buyBelowUsd !== undefined) {
    if (a.priceUsd === undefined) return no('buyBelowUsd', 'No price to check against');
    if (a.priceUsd > rules.buyBelowUsd + 1e-12) return no('buyBelowUsd', `Price $${a.priceUsd} is above the $${rules.buyBelowUsd} buy limit`);
  }
  if ((a.kind === 'sell' || a.kind === 'list') && rules.sellAboveUsd !== undefined) {
    if (a.priceUsd === undefined) return no('sellAboveUsd', 'No price to check against');
    if (a.priceUsd + 1e-12 < rules.sellAboveUsd) return no('sellAboveUsd', `Price $${a.priceUsd} is below the $${rules.sellAboveUsd} sell limit`);
  }
  if (a.kind === 'send' && !(a.to && (rules.sendTo ?? []).some((t) => t.toLowerCase() === a.to!.toLowerCase())))
    return no('sendTo', `${a.to || 'That recipient'} isn't on this strategy's send list`);
  return { ok: true };
};

/** Pretend money for paper mode: USD cash plus token holdings, filled at live prices. */
export type PaperBook = { cashUsd: number; tokens: Record<string, number>; spentUsd: number };
export const PAPER_START_USD = 100;

/** Live dollars spent since the strategy was loaded (paper entries carry usd 0, so they never count). */
export const spentSince = (log: AgentLogEntry[], since: number) => log.filter((e) => e.at >= since).reduce((s, e) => s + (e.usd > 0 ? e.usd : 0), 0);

/** Apply a paper fill to a book. Pure. Buys need cash; sells/sends/lists need tokens. */
export const paperFill = (book: PaperBook, a: ActionRequest): { ok: true; book: PaperBook } | { ok: false; reason: string } => {
  const key = a.token.replace(/^\$/, '').toUpperCase();
  const held = book.tokens[key] ?? 0;
  const tokens = { ...book.tokens };
  if (a.kind === 'buy') {
    if (a.usd > book.cashUsd + 1e-9) return { ok: false, reason: `Paper cash $${book.cashUsd.toFixed(2)} is too little` };
    const amt = a.amount ?? (a.priceUsd ? a.usd / a.priceUsd : 0);
    tokens[key] = held + amt;
    return { ok: true, book: { cashUsd: book.cashUsd - a.usd, tokens, spentUsd: book.spentUsd + a.usd } };
  }
  const amt = a.amount ?? 0;
  if (amt > held + 1e-9) return { ok: false, reason: `Paper book holds only ${held} ${key}` };
  tokens[key] = held - amt;
  const proceeds = a.kind === 'sell' ? amt * (a.priceUsd ?? 0) : 0;
  return { ok: true, book: { cashUsd: book.cashUsd + proceeds, tokens, spentUsd: book.spentUsd + (a.kind === 'send' ? a.usd : 0) } };
};

/** A starting file for "New strategy": buys a token slowly while it's cheap. */
export const exampleStrategy = (token = 'B0ASEX'): Strategy => ({
  format: STRATEGY_FORMAT,
  name: 'Slow accumulator',
  version: '1.0',
  goals: `Build a position in $${token} slowly. Buy small amounts a few times a day, only while the price is low. Never chase the price.`,
  rules: { tokens: [token], actions: ['buy'], buyBelowUsd: 0.001, maxPerTradeUsd: 2, maxPerDayUsd: 10, maxTotalUsd: 200, stop: { holdTokens: 100000 } },
  spec: {
    trades: `$${token}; BSV-21 only`,
    risk: 'Medium',
    spends: '$10/day, $200 total',
    often: 'A few times a day',
    stops: 'Holds 100k tokens',
    needs: 'Agent account with at least $20',
  },
  changelog: [{ version: '1.0', note: 'First version' }],
});

/** A strategy loaded into an account (same shape the app stores). */
export type Loaded = {
  strategy: Strategy;
  mode: 'paper' | 'live';
  loadedAt: number;
  /** Account value when loaded, for stop.downPct. */
  startValueUsd?: number;
};
