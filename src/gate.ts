/**
 * The one gate every spending action passes, from the CLI, `agent run` and MCP alike:
 *   kill switch / account stopped → daily cap → rate limit → loaded strategy's rules → (paper) fill.
 * Same order and rules as the app's checkAgentAction. Refusals are logged with the rule that refused.
 * In paper mode an allowed action is filled on the paper book and logged, and the caller must NOT sign.
 */
import {
  checkRules,
  dayStart,
  paperFill,
  spendAllowed,
  spentSince,
  type ActionRequest,
  type AgentLogEntry,
  type Loaded,
  type PaperBook,
  type RuleState,
} from './strategy.js';
import { allStopped, appendLog, getLoaded, getPaper, readLog, resolveAccount, setPaper, type AccountConfig } from './store.js';

export const RATE_LIMIT_PER_HOUR = 30;
const HOUR = 3_600_000;

/** Log actions that count toward the rate limit (attempted or done spends, live or paper). */
export const isSpendEntry = (e: AgentLogEntry) => /^(send|buy|sell|list|failed|paper-)/.test(e.action);

export const rateLimited = (log: AgentLogEntry[], now: number, limit = RATE_LIMIT_PER_HOUR) =>
  log.filter((e) => e.at > now - HOUR && e.at <= now && isSpendEntry(e)).length >= limit;

export type GateInput = {
  account: AccountConfig | null;
  stopAll: boolean;
  log: AgentLogEntry[];
  loaded: Loaded | null;
  book: PaperBook;
  action: ActionRequest;
  extra?: Omit<RuleState, 'spentTodayUsd' | 'spentTotalUsd'>;
  now: number;
};
export type GateResult =
  | { ok: true; paper: boolean; book?: PaperBook; logEntry?: AgentLogEntry }
  | { ok: false; reason: string; rule?: string; logEntry: AgentLogEntry };

/** Pure decision. `book` (paper) and `logEntry` are what the caller persists. */
export const evaluateGate = ({ account, stopAll, log, loaded, book, action: a, extra = {}, now }: GateInput): GateResult => {
  const refuse = (reason: string, rule?: string): GateResult => ({
    ok: false,
    reason,
    rule,
    logEntry: { at: now, action: 'refused', detail: `Refused ${a.kind} ${a.token}: ${reason}`, usd: 0, ...(rule && { rule }) },
  });
  const paper = loaded?.mode === 'paper';
  const acct = spendAllowed(
    account ? { identityAddress: account.identityAddress, labels: [], stopped: account.stopped, dailyCapUsd: account.dailyCapUsd, createdAt: account.importedAt } : null,
    stopAll,
    log,
    paper ? 0 : a.usd,
    now,
  );
  if (!acct.ok) return refuse(acct.reason, acct.reason.startsWith('Over today') ? 'dailyCap' : 'stop');
  if (rateLimited(log, now)) return refuse(`Rate limit: at most ${RATE_LIMIT_PER_HOUR} spending actions per hour`, 'rateLimit');
  if (!loaded) return { ok: true, paper: false };

  const st: RuleState = paper
    ? {
        spentTodayUsd: 0, // paper spending is tracked on the book, not per day
        spentTotalUsd: book.spentUsd,
        holding: loaded.strategy.rules.tokens.reduce((s, t) => s + (book.tokens[t.replace(/^\$/, '').toUpperCase()] ?? 0), 0),
        ...extra,
      }
    : {
        spentTodayUsd: spentSince(log, Math.max(dayStart(now), loaded.loadedAt)),
        spentTotalUsd: spentSince(log, loaded.loadedAt),
        startValueUsd: loaded.startValueUsd,
        ...extra,
      };
  const r = checkRules(loaded.strategy.rules, a, st);
  if (!r.ok) return refuse(r.reason, r.rule);
  if (!paper) return { ok: true, paper: false };

  const f = paperFill(book, a);
  if (!f.ok) return refuse(f.reason, 'paper');
  const what = a.amount ? `${+a.amount.toFixed(6)} ${a.ticker ?? a.token}` : (a.ticker ?? a.token);
  return {
    ok: true,
    paper: true,
    book: f.book,
    logEntry: {
      at: now,
      action: `paper-${a.kind}`,
      detail: `Paper ${a.kind} ${what}${a.usd ? ` for $${a.usd.toFixed(2)}` : ''}${a.priceUsd ? ` @ $${a.priceUsd}` : ''}${a.to ? ` to ${a.to}` : ''}`,
      usd: 0,
      rule: loaded.strategy.name,
    },
  };
};

/** Gate against stored state for an account; persists the log entry and paper book. */
export const gateAction = (name: string, action: ActionRequest, extra: GateInput['extra'] = {}, now = Date.now()) => {
  let account: AccountConfig | null = null;
  try {
    account = resolveAccount(name);
  } catch {
    account = null;
  }
  const loaded = getLoaded(name);
  const res = evaluateGate({ account, stopAll: allStopped(), log: readLog(name), loaded, book: getPaper(name), action, extra, now });
  if (res.ok && res.book) setPaper(name, res.book);
  if (res.logEntry) appendLog(name, res.logEntry);
  return res;
};
