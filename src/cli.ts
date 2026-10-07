#!/usr/bin/env node
import { banner } from './brand.js';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import * as act from './actions.js';
import * as mint from './mint.js';
import * as b1 from './brc100Actions.js';
import { login, unpair } from './paired.js';
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
  .description('pair with bWalletX on your phone: keys stay on the phone (scan the QR from your agent account)')
  .option('-a, --account <name>', 'local name for this paired account', 'phone')
  .action(
    run(async (o: { account: string }) => {
      if (!asJson) await banner();
      const p = await login(o.account, {});
      console.log(`\nPaired "${p.name}" with ${p.account}: ${p.scopes.join(', ')} until ${new Date(p.expiresAt).toLocaleDateString()}.`);
      console.log('Keep bWalletX open on that account while the CLI works. Try: bwalletx balance --account ' + p.name);
    }),
  );

program
  .command('pair')
  .description('pair bWalletX on your phone as your MAIN wallet: `serve --wallet paired` forwards BRC-100 calls to it')
  .requiredOption('--main', 'pair the main wallet (one wallet: the phone holds the keys and approves)')
  .option('-a, --account <name>', 'local name for this pairing', 'main')
  .action(
    run(async (o: { account: string }) => {
      if (!asJson) await banner();
      const p = await login(o.account, { mode: 'brc100' });
      console.log(`\nPaired "${p.name}" with ${p.account} as your main wallet until ${new Date(p.expiresAt).toLocaleDateString()}.`);
      console.log(`Serve it to sites: bwalletx serve --wallet paired --account ${p.name} --origin <site>. Revoke: bwalletx logout --account ${p.name}`);
    }),
  );

program
  .command('logout')
  .description('unpair a paired account (also disconnects it on the phone)')
  .option('-a, --account <name>', 'paired account', 'phone')
  .action(run(async (o: { account: string }) => (await unpair(o.account), console.log(`Unpaired ${o.account}.`))));

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
  .description('buy a BSV-21 token for at most --max-usd (cheapest whole buyable listing; +1% market fee)')
  .requiredOption('--max-usd <n>', 'most dollars to spend')
  .option('-a, --account <name>')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--dry-run', 'build and verify against the real listing with throwaway keys and synthetic funding; never broadcasts')
  .action(
    run(async (id: string, o: { maxUsd: string; account?: string; yes?: boolean; dryRun?: boolean }) => {
      const skip = o.yes || !!process.env.BWALLETX_YES;
      const r = await act.buy(id, Number(o.maxUsd.replace(/^\$/, '')), o.account, Date.now(), { dryRun: o.dryRun, ...(!skip && { confirm }) });
      print(r, () => r.text + (r.txid ? `\n  https://whatsonchain.com/tx/${r.txid}` : ''));
      if (!r.ok) process.exitCode = 1;
    }),
  );

const printSummary = (r: mint.Summary) =>
  print(r, () => {
    if (r.dryRun)
      return r.estimate
        ? `Dry run: ${r.estimate.sats.toLocaleString()} sats at ${r.estimate.satsPerKb} sat/kB${r.estimate.usd !== null ? ` ≈ ${usd(r.estimate.usd)}` : ''} (incl. the 1% mint fee; first item ×2 when it creates the collection). Nothing sent.`
        : 'Dry run.';
    return [
      `Minted ${r.minted.length}${r.skipped.length ? `, skipped ${r.skipped.length} already minted` : ''}.`,
      ...(r.collectionId ? [`Collection: ${r.collectionId}`] : []),
      ...r.minted.map((m) => `  ${m.title.padEnd(40)} ${m.txid}`),
      `Total: ${r.totalSats.toLocaleString()} sats ${usd(r.totalUsd)}`,
    ].join('\n');
  });

const collectionOf = mint.collectionOf;

program
  .command('mint <files...>')
  .description('mint files as NFTs on your paired phone (pairing scope "Mint NFTs"; the phone signs within its limits)')
  .option('-a, --account <name>', 'paired account')
  .option('--collection <name>', 'create this collection with the first file and add the rest to it')
  .option('--collection-id <id>', 'add to an existing collection of yours (<txid>_<vout>)')
  .option('--title <title>', 'title (one file only)')
  .option('--title-from-filename', 'title each item from its file name')
  .option('--description <text>', 'description for every item')
  .option('--dry-run', 'print sizes and the cost estimate only; nothing is sent')
  .action(
    run(async (files: string[], o: { account?: string; collection?: string; collectionId?: string; title?: string; titleFromFilename?: boolean; description?: string; dryRun?: boolean }) => {
      const items = mint.itemsFor(files, o);
      printSummary(await mint.runMint(items, { account: o.account, collection: collectionOf(o), description: o.description, dryRun: o.dryRun, out: asJson ? () => {} : console.log }));
    }),
  );

program
  .command('mint-manifest <manifest>')
  .description('mint every entry of a manifest ([{ title, file, sha256? }]) in order; resumable via <manifest>.progress.json')
  .option('-a, --account <name>', 'paired account')
  .option('--collection <name>', 'create this collection with the first entry and add the rest to it')
  .option('--collection-id <id>', 'add every entry to an existing collection of yours')
  .option('--description <text>', 'description for every item')
  .option('--dry-run', 'print sizes and the cost estimate only; nothing is sent')
  .action(
    run(async (manifest: string, o: { account?: string; collection?: string; collectionId?: string; description?: string; dryRun?: boolean }) => {
      const progressPath = mint.progressPathFor(manifest);
      printSummary(
        await mint.runMint(mint.readManifest(manifest), {
          account: o.account,
          collection: collectionOf(o),
          description: o.description,
          dryRun: o.dryRun,
          progressPath,
          out: asJson ? () => {} : console.log,
        }),
      );
      if (!o.dryRun && !asJson) console.log(`Progress: ${progressPath} (rerun the same command to resume)`);
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
  .action(run(async (o: { account?: string }) => print(await act.strategyShow(o.account))));
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
    run(async (o: { account?: string; limit: string }) => {
      const rows = await act.log(o.account, Number(o.limit));
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

// BRC-100 mode: the agent account as a full BRC-100 wallet, for sites and scripts (standalone accounts).
const brc100Account = b1.brc100Account;

const brc = program.command('brc100').description('the agent account as a BRC-100 wallet (standalone accounts): fund, balance, withdraw');
brc
  .command('fund')
  .description("move the account's plain BSV (its pay address) into its BRC-100 wallet")
  .option('-a, --account <name>', 'agent account')
  .option('--shared', "use the account's 1Sat Storage wallet (only if the app uses it as active storage)")
  .action(
    run(async (o: { account?: string; shared?: boolean }) => {
      const { name, payAddress, result: r } = await b1.brc100Fund(o.account, o.shared);
      const failed = r.results.filter((x) => !x.success);
      print(r, () => (r.moved || failed.length ? `Moved ${r.moved} coins (${r.sats} sats) into ${name}'s BRC-100 wallet.${failed.map((f) => `\n  ${f.outpoint}: ${f.error}`).join('')}` : `Nothing to move: no BSV at ${payAddress} or the app's receive addresses.`));
    }),
  );
brc
  .command('migrate')
  .description("move the balance of the CLI's old private wallet (0.3.0–0.3.3) into the shared wallet the app uses")
  .option('-a, --account <name>', 'agent account')
  .action(
    run(async (o: { account?: string }) => {
      const { name, keys, b, w: shared } = await brc100Account(o.account, true);
      const local = await b.openWallet(name, keys);
      try {
        const r = await b.migrateLocalToShared(local, shared, (detail) => appendLog(name, { at: Date.now(), action: 'brc100-migrate-note', detail, usd: 0 }));
        if (r.sats) appendLog(name, { at: Date.now(), action: 'brc100-migrate', detail: `Moved ${r.sats} sats from the CLI wallet into the shared wallet ${r.txid ?? ''}`, usd: 0 });
        print(r, () => (r.sats ? `Moved ${r.sats.toLocaleString()} sats into the shared wallet: ${r.txid}` : 'Nothing to move: the old CLI wallet is empty.'));
      } finally {
        await local.close();
        await shared.close();
      }
    }),
  );
brc
  .command('addresses')
  .description("the addresses this account can take BSV in at: its pay address and the bWalletX app's receive addresses")
  .option('-a, --account <name>', 'agent account')
  .action(
    run(async (o: { account?: string }) => {
      const rows = await b1.brc100Addresses(o.account);
      print(rows, () => rows.map((r) => `${r.address}  ${r.label}`).join('\n'));
    }),
  );
brc
  .command('balance')
  .description("the BRC-100 wallet's spendable BSV")
  .option('-a, --account <name>', 'agent account')
  .option('--shared', "use the account's 1Sat Storage wallet (only if the app uses it as active storage)")
  .action(
    run(async (o: { account?: string; shared?: boolean }) => {
      const r = await b1.brc100Balance(o.account, o.shared);
      print(r, () => `${r.account}: ${r.sats.toLocaleString()} sats (${usd(r.usd)})\n  identity key ${r.identityKey}`);
    }),
  );
brc
  .command('withdraw <usd> <address>')
  .description('send BSV worth <usd> dollars ("all" for everything) from the BRC-100 wallet to an address')
  .option('-a, --account <name>', 'agent account')
  .option('--shared', "use the account's 1Sat Storage wallet (only if the app uses it as active storage)")
  .action(
    run(async (amount: string, address: string, o: { account?: string; shared?: boolean }) => {
      const r = await b1.brc100Withdraw(amount === 'all' ? 'all' : Number(amount), address, o.account, o.shared);
      print(r, () => `Sent ${r.sats.toLocaleString()} sats to ${address}: ${r.txid}`);
    }),
  );

program
  .command('serve')
  .description('serve the agent account as a BRC-100 wallet on http://localhost:3321 for the sites you allow')
  .option('-a, --account <name>', 'agent account')
  .option('--wallet <kind>', 'local (the CLI wallet), shared (1Sat Storage) or paired (forward to your phone: `bwalletx pair --main`)')
  .option('--shared', 'alias for --wallet shared')
  .requiredOption('-o, --origin <host...>', 'sites allowed to use the wallet, e.g. www.tokenblaster.lol localhost:3000')
  .option('-p, --port <n>', 'port', '3321')
  .action(
    run(async (o: { account?: string; origin: string[]; port: string; shared?: boolean; wallet?: string }) => {
      const kind = o.wallet ?? (o.shared ? 'shared' : 'local');
      if (!['local', 'shared', 'paired'].includes(kind)) throw new Error(`--wallet must be local, shared or paired (got "${kind}")`);
      if (o.shared && kind !== 'shared') throw new Error('--shared conflicts with --wallet ' + kind);
      const log = (l: string) => console.log(`${new Date().toLocaleTimeString()}  ${l}`);
      if (kind === 'paired') {
        const { readPairing } = await import('./paired.js');
        const n = o.account ?? 'main';
        const p = readPairing(n);
        if (!p) throw new Error(`"${n}" isn't paired. Run \`bwalletx pair --main --account ${n}\` first.`);
        if (p.mode !== 'brc100') throw new Error(`"${n}" is an agent pairing, not a main-wallet one. Run \`bwalletx pair --main\`.`);
        const b = await import('./brc100.js');
        const w = await b.pairedBackend(n);
        await b.serve(w, { account: n, origins: o.origin, port: Number(o.port), onEvent: log });
        console.log(`Your paired bWalletX (${p.account}) is a BRC-100 wallet on http://localhost:${o.port}`);
        console.log(`  allowed: ${o.origin.join(', ')}`);
        console.log('  keys stay on the phone: keep bWalletX open and unlocked; it approves every spend. No local fallback. Ctrl-C to stop.');
        await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
        await w.close();
        return;
      }
      const { name, b, w } = await brc100Account(o.account, kind === 'shared');
      w.startMonitor();
      const sats = await b.walletBalance(w).catch(() => 0);
      await b.serve(w, { account: name, origins: o.origin, port: Number(o.port), onEvent: (l) => console.log(`${new Date().toLocaleTimeString()}  ${l}`) });
      console.log(`bWalletX agent "${name}" is a BRC-100 wallet on http://localhost:${o.port}`);
      console.log(`  identity key ${w.identityKey}`);
      console.log(`  balance ${sats.toLocaleString()} sats${sats ? '' : ' (run `bwalletx brc100 fund` to move the pay address in)'}`);
      console.log(`  allowed: ${o.origin.join(', ')}`);
      console.log('  every spend passes the kill switch, daily cap and rate limit; `bwalletx stop` refuses all. Ctrl-C to stop.');
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      await w.close();
    }),
  );

// Bare `bwalletx`: the banner, then help.
if (process.argv.length <= 2) {
  await banner();
  program.outputHelp();
} else {
  await program.parseAsync();
}
