#!/usr/bin/env node
import { banner } from './brand.js';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import * as act from './actions.js';
import * as mint from './mint.js';
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
      const p = await login(o.account);
      console.log(`\nPaired "${p.name}" with ${p.account}: ${p.scopes.join(', ')} until ${new Date(p.expiresAt).toLocaleDateString()}.`);
      console.log('Keep bWalletX open on that account while the CLI works. Try: bwalletx balance --account ' + p.name);
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

const collectionOf = (o: { collection?: string; collectionId?: string }): mint.CollectionChoice => {
  if (o.collection && o.collectionId) throw new Error('Use --collection (new) or --collection-id (existing), not both');
  if (o.collectionId) {
    if (!/^[0-9a-f]{64}_\d+$/.test(o.collectionId)) throw new Error('--collection-id must be <txid>_<vout>');
    return { kind: 'existing', id: o.collectionId };
  }
  return o.collection ? { kind: 'new', name: o.collection } : { kind: 'none' };
};

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
      if (o.title && files.length > 1) throw new Error('--title is for one file; use --title-from-filename for several');
      if (!o.title && !o.titleFromFilename) throw new Error('Give --title, or --title-from-filename');
      const items = files.map((f) => ({ file: f, title: o.title ?? mint.titleFromFilename(f) }));
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
const brc100Account = async (name?: string, shared = false) => {
  const { isPaired } = await import('./paired.js');
  const n = name ?? readConfig().defaultAccount ?? Object.keys(readConfig().accounts)[0];
  if (!n) throw new Error('No accounts yet. Run `bwalletx key import <file>`.');
  if (isPaired(n)) throw new Error(`"${n}" is paired: its keys stay on the phone, so it can't run as a BRC-100 wallet here. Import an agent key file for this.`);
  resolveAccount(n);
  const keys = await act.unlock(n);
  const b = await import('./brc100.js');
  // Default: the CLI's own wallet. --shared opens the account's 1Sat Storage wallet, which only stays in step
  // with the app if the app uses that remote as the account's active storage (it normally doesn't).
  return { name: n, keys, b, w: shared ? await b.openSharedWallet(keys) : await b.openWallet(n, keys) };
};

const brc = program.command('brc100').description('the agent account as a BRC-100 wallet (standalone accounts): fund, balance, withdraw');
brc
  .command('fund')
  .description("move the account's plain BSV (its pay address) into its BRC-100 wallet")
  .option('-a, --account <name>', 'agent account')
  .option('--shared', "use the account's 1Sat Storage wallet (only if the app uses it as active storage)")
  .action(
    run(async (o: { account?: string; shared?: boolean }) => {
      const { name, keys, b, w } = await brc100Account(o.account, o.shared);
      try {
        const r = await b.fundFromPayAddress(w, keys);
        appendLog(name, { at: Date.now(), action: 'brc100-fund', detail: `Moved ${r.moved} coins (${r.sats} sats) into the BRC-100 wallet`, usd: 0 });
        const failed = r.results.filter((x) => !x.success);
        print(r, () => (r.moved || failed.length ? `Moved ${r.moved} coins (${r.sats} sats) into ${name}'s BRC-100 wallet.${failed.map((f) => `\n  ${f.outpoint}: ${f.error}`).join('')}` : `Nothing to move: no BSV at ${w.payAddress} or the app's receive addresses.`));
      } finally {
        await w.close();
      }
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
      const { isPaired } = await import('./paired.js');
      const n = o.account ?? readConfig().defaultAccount ?? Object.keys(readConfig().accounts)[0];
      if (!n) throw new Error('No accounts yet.');
      if (isPaired(n)) throw new Error(`"${n}" is paired: its keys stay on the phone.`);
      const keys = await act.unlock(n);
      const { appAddresses } = await import('./brc100.js');
      const { PrivateKey } = await import('@bsv/sdk');
      const rows = [{ label: 'pay address', address: PrivateKey.fromWif(keys.payPk).toAddress() }, ...appAddresses(keys.identityPk, 5).map(({ label, address }) => ({ label, address }))];
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
      const { name, b, w } = await brc100Account(o.account, o.shared);
      try {
        const sats = await b.walletBalance(w);
        const { bsvUsd } = await import('./market.js');
        const rate = await bsvUsd();
        print({ account: name, identityKey: w.identityKey, sats, usd: (sats / 1e8) * rate }, () => `${name}: ${sats.toLocaleString()} sats (${usd((sats / 1e8) * rate)})\n  identity key ${w.identityKey}`);
      } finally {
        await w.close();
      }
    }),
  );
brc
  .command('withdraw <usd> <address>')
  .description('send BSV worth <usd> dollars ("all" for everything) from the BRC-100 wallet to an address')
  .option('-a, --account <name>', 'agent account')
  .option('--shared', "use the account's 1Sat Storage wallet (only if the app uses it as active storage)")
  .action(
    run(async (amount: string, address: string, o: { account?: string; shared?: boolean }) => {
      const { name, b, w } = await brc100Account(o.account, o.shared);
      try {
        const { bsvUsd } = await import('./market.js');
        const { gateAction } = await import('./gate.js');
        const { P2PKH } = await import('@bsv/sdk');
        const rate = await bsvUsd();
        const have = await b.walletBalance(w);
        const sats = amount === 'all' ? have - 300 : Math.round((Number(amount) / rate) * 1e8);
        if (!(sats > 0) || sats > have) throw new Error(`Can't send ${sats} sats: the wallet holds ${have}`);
        const g = gateAction(name, { kind: 'send', token: 'BSV', usd: (sats / 1e8) * rate, to: address });
        if (!g.ok) throw new Error(`Refused: ${g.reason}`);
        if (g.paper) throw new Error('Paper mode: nothing is signed');
        const r = await w.wallet.createAction(
          { description: 'bwalletx withdraw', outputs: [{ lockingScript: new P2PKH().lock(address).toHex(), satoshis: sats, outputDescription: 'withdraw' }], options: { acceptDelayedBroadcast: false } },
          'bwalletx-cli',
        );
        await w.sendWaiting();
        appendLog(name, { at: Date.now(), action: 'send', detail: `BRC-100 withdraw ${sats} sats to ${address} ${r.txid ?? ''}`, usd: (sats / 1e8) * rate });
        print({ txid: r.txid, sats }, () => `Sent ${sats.toLocaleString()} sats to ${address}: ${r.txid}`);
      } finally {
        await w.close();
      }
    }),
  );

program
  .command('serve')
  .description('serve the agent account as a BRC-100 wallet on http://localhost:3321 for the sites you allow')
  .option('-a, --account <name>', 'agent account')
  .option('--shared', "use the account's 1Sat Storage wallet (only if the app uses it as active storage)")
  .requiredOption('-o, --origin <host...>', 'sites allowed to use the wallet, e.g. www.tokenblaster.lol localhost:3000')
  .option('-p, --port <n>', 'port', '3321')
  .action(
    run(async (o: { account?: string; origin: string[]; port: string; shared?: boolean }) => {
      const { name, b, w } = await brc100Account(o.account, o.shared);
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
