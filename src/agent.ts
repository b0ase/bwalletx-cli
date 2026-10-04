/**
 * `bwalletx agent run <account>`: a rule-driven loop, no AI. Each tick, for every BSV-21 id the loaded
 * strategy names, if "buy" is allowed and buyBelowUsd is set and the floor price is at or below it,
 * ask to buy maxPerTradeUsd worth. Every request passes the same gate (stop, daily cap, rate limit,
 * rules); paper mode fills on the $100 paper book; live mode buys for real (buy.ts).
 */
import { buy } from './actions.js';
import { price } from './actions.js';
import { TOKEN_ID, normTokenId } from './market.js';
import { allStopped, appendLog, getLoaded, resolveAccount } from './store.js';

export type TickLine = { at: number; text: string };

export async function agentTick(account: string, now = Date.now()): Promise<TickLine[]> {
  const out: TickLine[] = [];
  const say = (text: string) => out.push({ at: now, text });
  const a = resolveAccount(account);
  if (allStopped()) return say('All agents stopped (bwalletx resume to continue)'), out;
  if (a.stopped) return say('Account stopped'), out;
  const l = getLoaded(a.name);
  if (!l) return say('No strategy loaded (bwalletx strategy load <file>)'), out;
  const r = l.strategy.rules;
  if (!r.actions.includes('buy') || r.buyBelowUsd === undefined) return say('Strategy has no buy rule (actions "buy" + buyBelowUsd); nothing to do'), out;
  const ids = r.tokens.map(normTokenId).filter((t) => TOKEN_ID.test(t));
  if (!ids.length) return say('Strategy names tickers only; the CLI agent needs BSV-21 ids (txid_vout) in rules.tokens'), out;
  for (const id of ids) {
    try {
      const p = await price(id);
      const name = p.sym ?? id.slice(0, 8);
      if (p.floorUsdPerToken === null) {
        say(`${name}: no listings`);
        continue;
      }
      if (p.floorUsdPerToken > r.buyBelowUsd) {
        say(`${name}: $${p.floorUsdPerToken.toPrecision(4)} is above buyBelowUsd $${r.buyBelowUsd}; waiting`);
        continue;
      }
      const res = await buy(id, r.maxPerTradeUsd, a.name, now);
      say(`${name}: ${res.text}`);
    } catch (e) {
      say(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export async function agentRun(account: string, intervalSec: number, opts: { once?: boolean } = {}) {
  const a = resolveAccount(account);
  const every = Math.max(30, intervalSec) * 1000;
  appendLog(a.name, { at: Date.now(), action: 'agent', detail: `Agent started (every ${every / 1000}s)`, usd: 0 });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (running) {
    for (const line of await agentTick(a.name)) console.log(`${new Date(line.at).toISOString()} ${line.text}`);
    if (opts.once) break;
    const until = Date.now() + every;
    while (running && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  }
  appendLog(a.name, { at: Date.now(), action: 'agent', detail: 'Agent stopped', usd: 0 });
}
