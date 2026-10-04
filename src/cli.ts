#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import * as act from './actions.js';
import { agentRun } from './agent.js';
import { confirm } from './passphrase.js';
import { keyFilePath, allStopped, appendLog, readConfig, resolveAccount, setAllStopped, updateAccount, writeConfig } from './store.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const program = new Command();
let asJson = false;
const print = (v: unknown, human?: () => string) => console.log(asJson || !human ? JSON.stringify(v, null, 2) : human());
const usd = (n: number | null | undefined) => (n == null ? '—' : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`);
const run =
  <A extends unknown[]>(fn: (...a: A) => Promise<void> | void) =>
  async (...a: A) => {
    try {
      await fn(...a);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  };

program
  .name('bwalletx')
  .description('bWalletX CLI: run bWalletX agent accounts from the command line (standalone mode)')
  .version(VERSION)
  .option('--json', 'machine-readable output')
  .hook('preAction', (cmd) => {
    asJson = !!cmd.opts().json;
  });

program
  .command('login')
  .description('pair with the bWalletX app (coming soon)')
  .action(() => console.log('Pairing with the app is coming; use `bwalletx key import`'));

const key = program.command('key').description('agent account key files');
key
  .command('import <file>')
  .description('import an agent account key file exported by bWalletX (bwalletx.agentkey/1)')
  .action(
    run(async (file: string) => {
      const a = await act.importKey(file);
      print(a, () => `Imported "${a.name}"\n  pay address: ${a.payAddress}\n  ord address: ${a.ordAddress}\n  stored: ${keyFilePath(a.name)} (encrypted, mode 600)`);
    }),
  );

program
  .command('accounts')
  .description('list imported agent accounts')
  .action(
    run(() => {
      const rows = act.listAccounts();
      print(rows, () =>
        rows.length
          ? rows
              .map((a) => `${a.default ? '*' : ' '} ${a.name.padEnd(14)} ${a.payAddress}  ${a.stopped ? 'STOPPED ' : ''}${a.dailyCapUsd ? `cap $${a.dailyCapUsd}/day  ` : ''}${a.strategy ?? 'no strategy'}`)
              .join('\n')
          : 'No accounts yet. Run `bwalletx key import <file>`.',
      );
    }),
  );

program
  .command('default <account>')
  .description('set the default account')
  .action(
    run((name: string) => {
      resolveAccount(name);
      const c = readConfig();
      c.defaultAccount = name;
      writeConfig(c);
      console.log(`Default account: ${name}`);
    }),
  );

program
  .command('cap <account> <usdPerDay>')
  .description('set an account daily cap in USD ("off" to clear)')
  .action(
    run((name: string, v: string) => {
      resolveAccount(name);
      const cap = v === 'off' ? null : Number(v);
      if (cap !== null && !(cap > 0)) throw new Error('Cap must be a positive number or "off"');
      updateAccount(name, { dailyCapUsd: cap });
      console.log(cap ? `${name}: daily cap $${cap}` : `${name}: no daily cap`);
    }),
  );

program
  .command('balance')
  .description('BSV and BSV-21 token balances, in USD')
  .option('-a, --account <name>')
  .action(
    run(async (o: { account?: string }) => {
      const b = await act.balance(o.account);
      print(b, () =>
        [
          `${b.account}  (BSV ${usd(b.bsvUsd)})`,
          `  BSV     ${(b.bsv.sats / 1e8).toFixed(8)}  ${usd(b.bsv.usd)}`,
          ...b.tokens.map((t) => `  ${(t.sym ?? t.id.slice(0, 10)).padEnd(7)} ${t.amount}  ${usd(t.valueUsd)}`),
          `  total   ${usd(b.totalUsd)}`,
          ...(b.paper ? [`  paper book: cash ${usd(b.paper.cashUsd)}, tokens ${JSON.stringify(b.paper.tokens)}`] : []),
        ].join('\n'),
      );
    }),
  );

program
  .command('price <tokenId>')
  .description('floor price of a BSV-21 token')
  .action(
    run(async (id: string) => {
      const p = await act.price(id);
      print(p, () => `${p.sym ?? p.id}: ${p.floorUsdPerToken === null ? 'no listings' : `${usd(p.floorUsdPerToken)} per token (${p.floorSatsPerToken!.toPrecision(4)} sats), ${p.listings} listings`}`);
    }),
  );

program
  .command('send <usd> <to>')
  .description('send BSV worth <usd> dollars to an address or paymail')
  .option('-a, --account <name>')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(
    run(async (amount: string, to: string, o: { account?: string; yes?: boolean }) => {
      const n = Number(amount.replace(/^\$/, ''));
      const a = resolveAccount(o.account);
      if (!o.yes && !(await confirm(`Send $${n} of BSV from ${a.name} to ${to}?`))) throw new Error('Not confirmed (pass --yes to skip)');
      const r = await act.send(n, to, a.name);
      print(r, () => r.text + (r.txid ? `\n  https://whatsonchain.com/tx/${r.txid}` : ''));
      if (!r.ok) process.exitCode = 1;
    }),
  );

program
  .command('buy <tokenId>')
  .description('buy a BSV-21 token for at most --max-usd')
  .requiredOption('--max-usd <n>', 'most dollars to spend')
  .option('-a, --account <name>')
  .action(
    run(async (id: string, o: { maxUsd: string; account?: string }) => {
      const r = await act.buy(id, Number(o.maxUsd), o.account);
      print(r, () => r.text);
      if (!r.ok) process.exitCode = 1;
    }),
  );

const strategy = program.command('strategy').description('load, show or unload a bwalletx.strategy/1 file');
strategy
  .command('load <file>')
  .option('-a, --account <name>')
  .option('--live', 'run live with real money (default: paper, $100 pretend book)')
  .action(
    run(async (file: string, o: { account?: string; live?: boolean }) => {
      if (o.live && !process.env.BWALLETX_YES && !(await confirm('Load this strategy LIVE (real money)?'))) throw new Error('Not confirmed (set BWALLETX_YES=1 to skip)');
      const r = await act.strategyLoad(file, o.account, !!o.live);
      print(r, () => `Loaded "${r.strategy.name}" v${r.strategy.version} into ${r.account} (${r.mode}${r.mode === 'paper' ? ', $100 paper book' : ''})`);
    }),
  );
strategy
  .command('show')
  .option('-a, --account <name>')
  .action(run((o: { account?: string }) => print(act.strategyShow(o.account))));
strategy
  .command('unload')
  .option('-a, --account <name>')
  .action(run((o: { account?: string }) => console.log(act.strategyUnload(o.account) ? 'Unloaded' : 'No strategy loaded')));

program
  .command('agent')
  .description('run an account\'s strategy unattended')
  .command('run <account>')
  .option('--interval <sec>', 'seconds between checks (min 30)', '300')
  .option('--once', 'run one check and exit')
  .action(run((name: string, o: { interval: string; once?: boolean }) => agentRun(name, Number(o.interval), { once: o.once })));

program
  .command('log')
  .description('activity log (~/.bwalletx/log/<account>.jsonl)')
  .option('-a, --account <name>')
  .option('-n, --limit <n>', 'entries', '50')
  .action(
    run((o: { account?: string; limit: string }) => {
      const rows = act.log(o.account, Number(o.limit));
      print(rows, () =>
        rows.map((e) => `${new Date(e.at).toISOString()}  ${e.action.padEnd(12)} ${e.detail}${e.usd ? `  [${usd(e.usd)}]` : ''}${e.rule ? `  (${e.rule})` : ''}${e.txid ? `  ${e.txid}` : ''}`).join('\n') || 'No activity',
      );
    }),
  );

const stopAll = (on: boolean) => () => {
  setAllStopped(on);
  for (const n of Object.keys(readConfig().accounts)) appendLog(n, { at: Date.now(), action: on ? 'stop' : 'resume', detail: on ? 'All agents stopped' : 'All agents resumed', usd: 0 });
  console.log(on ? 'All agents stopped. Every spending action is refused until `bwalletx resume`.' : allStopped() ? 'Still stopped?' : 'Resumed.');
};
program.command('stop').description('kill switch: refuse every spending action').action(run(stopAll(true)));
program.command('resume').description('turn the kill switch off').action(run(stopAll(false)));

program
  .command('mcp')
  .description('run as a stdio MCP server')
  .action(
    run(async () => {
      const { runMcp } = await import('./mcp.js');
      await runMcp(VERSION);
    }),
  );

await program.parseAsync();
