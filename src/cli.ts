#!/usr/bin/env node
import { banner } from './brand.js';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import * as act from './actions.js';
import * as mint from './mint.js';
import * as sell from './sell.js';
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

key
  .command('new <name>')
  .description('make a fresh agent account on this machine: new keys in an encrypted key file (keep it), then imported')
  .option('--out <file>', 'where to write the key file', '<name>.key.json')
  .action(
    run(async (name: string, o: { out: string }) => {
      const out = o.out === '<name>.key.json' ? `${name}.key.json` : o.out;
      const a = await act.newKey(name, out, process.env.BWALLETX_PASSPHRASE || undefined);
      print(a, () => `Made "${a.name}"\n  identity key: ${a.identityKey}\n  pay address: ${a.payAddress}\n  ord address: ${a.ordAddress}\n  key file: ${out} (keep it; it is the only copy of these keys)\n  stored: ${keyFilePath(a.name)} (encrypted, mode 600)`);
    }),
  );

key
  .command('info <account>')
  .description('public details only: identity key, pay and ord addresses, cap and approval threshold')
  .action(
    run((name: string) => {
      const a = resolveAccount(name);
      const info = {
        name: a.name,
        identityKey: a.identityKey ?? null,
        payAddress: a.payAddress,
        payPubkey: a.payPubkey ?? null,
        ordAddress: a.ordAddress,
        dailyCapUsd: a.dailyCapUsd,
        approveAboveUsd: a.approveAboveUsd ?? null,
      };
      print(info, () =>
        [
          `${a.name}`,
          `  identity key: ${info.identityKey ?? '(re-import the key file to record it)'}`,
          `  pay address: ${a.payAddress}`,
          `  pay pubkey: ${info.payPubkey ?? '(re-import the key file to record it)'}`,
          `  ord address: ${a.ordAddress}`,
          `  daily cap: ${a.dailyCapUsd ? `$${a.dailyCapUsd}` : 'none'}`,
          `  owner approval above: ${info.approveAboveUsd != null ? `$${info.approveAboveUsd}` : 'none'}`,
        ].join('\n'),
      );
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
  .command('approve-above <account> <usd>')
  .description('refuse single spends above this many USD until the owner approves them ("off" to clear)')
  .action(
    run((name: string, v: string) => {
      resolveAccount(name);
      const t = v === 'off' ? null : Number(v);
      if (t !== null && !(t >= 0)) throw new Error('Threshold must be a number of USD (0 or more) or "off"');
      updateAccount(name, { approveAboveUsd: t });
      console.log(t !== null ? `${name}: spends over $${t} need owner approval` : `${name}: no approval threshold`);
    }),
  );

program
  .command('ratelimit <account> <perHour>')
  .description('spending actions per hour for one account (a number, "off" = no limit, "default" = 30)')
  .action(
    run((name: string, v: string) => {
      resolveAccount(name);
      const n = v === 'off' ? 0 : v === 'default' ? null : Number(v);
      if (n !== null && !(Number.isInteger(n) && n >= 0)) throw new Error('Rate must be a whole number, "off" or "default"');
      updateAccount(name, { ratePerHour: n });
      console.log(n === 0 ? `${name}: no rate limit` : n ? `${name}: at most ${n} spending actions per hour` : `${name}: default rate limit`);
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

program
  .command('buy-listing <outpoint>')
  .description('buy one 1Sat listing (ordinal or BSV-21) by its outpoint with the account BRC-100 wallet (+1% market fee)')
  .option('--max-usd <n>', 'refuse if the total with fees is over this')
  .option('-a, --account <name>', 'agent account (its BRC-100 wallet signs)')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--dry-run', 'build the purchase transaction, sign and broadcast nothing')
  .action(
    run(async (outpoint: string, o: { maxUsd?: string; account?: string; yes?: boolean; dryRun?: boolean }) => {
      const skip = o.yes || !!process.env.BWALLETX_YES;
      printSell(await sell.buyListing({ account: o.account, outpoint, dryRun: o.dryRun, ...(o.maxUsd !== undefined && { maxUsd: Number(o.maxUsd.replace(/^\$/, '')) }), ...(!skip && { confirm }) }));
    }),
  );

const printSell = (r: sell.SellResult) => {
  print(r, () =>
    [
      r.text,
      ...(r.built ? [`  built: ${r.built.description}`, ...r.built.outputs.map((x, i) => `    out ${i}: ${String(x.satoshis).padStart(9)} sats  ${x.description ?? ''}`)] : []),
      ...(r.txid ? [`  https://whatsonchain.com/tx/${r.txid}`] : []),
    ].join('\n'),
  );
  if (!r.ok) process.exitCode = 1;
};

program
  .command('list <outpoint>')
  .description('list an ordinal, OpNS name or BSV-21 token output from the account wallet on the 1Sat order book (OrdLock v2)')
  .requiredOption('--price <sats>', 'asking price in sats (whole listing)')
  .option('--amount <n>', 'BSV-21 only: list this many tokens from the output (default: all of it)')
  .option('-a, --account <name>', 'agent account (its BRC-100 wallet signs)')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--dry-run', 'build the listing transaction, sign and broadcast nothing')
  .action(
    run(async (outpoint: string, o: { price: string; amount?: string; account?: string; yes?: boolean; dryRun?: boolean }) => {
      const skip = o.yes || !!process.env.BWALLETX_YES;
      printSell(await sell.listForSale({ account: o.account, outpoint, priceSats: Number(o.price), amount: o.amount, dryRun: o.dryRun, ...(!skip && { confirm }) }));
    }),
  );

program
  .command('unlist <outpoint>')
  .description('cancel one of the account\'s listings; the item returns to its wallet')
  .option('-a, --account <name>', 'agent account')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--dry-run', 'build the cancel transaction, sign and broadcast nothing')
  .action(
    run(async (outpoint: string, o: { account?: string; yes?: boolean; dryRun?: boolean }) => {
      const skip = o.yes || !!process.env.BWALLETX_YES;
      printSell(await sell.unlist({ account: o.account, outpoint, dryRun: o.dryRun, ...(!skip && { confirm }) }));
    }),
  );

program
  .command('listings')
  .description('the account\'s open 1Sat listings (wallet OrdLock outputs + BSV-21 listings made here), with live status')
  .option('-a, --account <name>', 'agent account')
  .action(
    run(async (o: { account?: string }) => {
      const r = await sell.myListings(o.account);
      print(r, () =>
        r.listings.length
          ? [`${r.account}: ${r.listings.length} listing(s)`, ...r.listings.map((l) => `  ${l.outpoint}  ${l.kind.padEnd(7)} ${(l.priceSats ?? '?').toLocaleString().padStart(12)} sats  ${usd(l.priceUsd).padStart(8)}  ${l.status.padEnd(7)} ${l.token ? `${l.token.amount} ${l.token.sym ?? l.token.id}` : (l.name ?? '')}`)].join('\n')
          : `${r.account}: no listings`,
      );
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

// OpNS: headless batch minting from one agent account (docs/OPNS-HEADLESS.md).
const opns = program.command('opns').description('OpNS names: mint whole lists unattended from an agent account, watch, sweep');
opns
  .command('mint <files...>')
  .description('mine every name in the lists (sorted, deduped, resumable); vault/gift names go to --to, the rest are listed for sale')
  .option('-a, --account <name>', 'agent account (its BRC-100 wallet pays)')
  .option('--to <address>', "owner's ordinals address: vault and gift names are locked straight to it")
  .option('--to-pay <address>', 'owner address that sale proceeds pay to (OrdLock v2 pay address); default the agent account')
  .option('--vault <file>', 'names to keep: minted to --to, never listed')
  .option('--gift <file>', 'names to give: minted to --to, never listed')
  .option('--budget <sats>', 'most this run may spend (fees + listings); remembered for later runs')
  .option('--threads <n>', 'proof-of-work threads (default: cores - 1)')
  .option('--fresh', 'forget the saved progress for this account and start a new job')
  .option('--prune', 'drop names still to do that are not in these lists (hand them to another machine)')
  .option('--lists-only', 'the --vault/--gift files only route names; they add none (a second machine)')
  .option('-q, --quiet', 'no progress line (still writes the state + report files)')
  .action(
    run(async (files: string[], o: { account?: string; to?: string; toPay?: string; vault?: string; gift?: string; budget?: string; threads?: string; fresh?: boolean; prune?: boolean; listsOnly?: boolean; quiet?: boolean }) => {
      const { opnsMint, reportPath } = await import('./opns/headless.js');
      const budgetSats = o.budget === undefined ? undefined : Number(o.budget);
      if (budgetSats !== undefined && !(Number.isInteger(budgetSats) && budgetSats > 0)) throw new Error('--budget is a whole number of sats');
      const threads = o.threads === undefined ? undefined : Number(o.threads);
      const r = await opnsMint({ account: o.account, files, vault: o.vault, gift: o.gift, to: o.to, payTo: o.toPay, budgetSats, threads, fresh: o.fresh, prune: o.prune, listsOnly: o.listsOnly, quiet: o.quiet });
      const { summarise } = await import('./opns/batch.js');
      const m = summarise(r.state);
      print({ stopped: r.stopped, error: r.error, ...m }, () =>
        `${r.stopped === 'finished' ? 'Finished' : `Stopped (${r.error ?? r.stopped})`}: ${m.done}/${m.total} done, ${m.listed} listed, ${m.vaulted} to owner, ${m.skipped} taken, ${m.spentSats.toLocaleString()} sats spent.\n  report: ${reportPath(r.state.account)}`);
      if (r.stopped === 'error') process.exitCode = 1;
    }),
  );
opns
  .command('status')
  .description('progress of the batch job: names done, listed, spent, ETA')
  .option('-a, --account <name>', 'agent account')
  .action(
    run(async (o: { account?: string }) => {
      const { opnsStatus } = await import('./opns/headless.js');
      const { fmtDuration } = await import('./opns/batch.js');
      const s = opnsStatus(o.account);
      if (!s) return print(null, () => 'No OpNS batch job for this account yet.');
      print(s, () =>
        [
          `${s.account}: ${s.done}/${s.total} names done · ${s.listed} listed · ${s.vaulted} to owner · ${s.skipped} taken · ${s.pending} to go${s.notListed ? ` · ${s.notListed} not listed yet` : ''}`,
          `  spent ${s.spentSats.toLocaleString()} of ${s.budgetSats.toLocaleString()} sats · ${s.txs} txs · ${s.secsPerChar ? `${s.secsPerChar.toFixed(1)} s/char` : ''} · ETA ${fmtDuration(s.etaSeconds)}`,
          s.waiting
            ? `  waiting for confirmations on "${s.waiting.name}" since ${new Date(s.waiting.since).toLocaleString()} · retry ${s.waiting.until > Date.now() ? `in ${Math.ceil((s.waiting.until - Date.now()) / 60_000)} min` : 'due now'} (${s.waiting.reason.slice(0, 100)})`
            : '',
          s.stopped ? `  last stop: ${s.stopped}` : '',
          `  report: ${s.report}`,
        ].filter(Boolean).join('\n'));
    }),
  );
opns
  .command('send <to> <names...>')
  .description('send names from the agent account to one ordinals address (a gift)')
  .option('-a, --account <name>', 'agent account')
  .option('-y, --yes', 'no confirmation prompt')
  .option('--dry-run', 'show what would be sent, send nothing')
  .action(
    run(async (to: string, names: string[], o: { account?: string; yes?: boolean; dryRun?: boolean }) => {
      if (!o.dryRun && !o.yes && !process.env.BWALLETX_YES && !(await confirm(`Send ${names.join(', ')} to ${to}? This cannot be undone.`))) return console.log('Cancelled.');
      const { opnsSend } = await import('./opns/headless.js');
      const r = await opnsSend({ account: o.account, names, to, dryRun: o.dryRun });
      for (const n of r.names) console.log(n.action === 'sent' ? `${n.name}: sent ${n.txid}` : n.action === 'failed' ? `${n.name}: FAILED ${n.error}` : `${n.name}: ${n.action}`);
      if (r.names.some((n) => n.action === 'failed')) process.exitCode = 1;
    }),
  );
opns
  .command('unlist <to>')
  .description('cancel the sale listings of the names in --file and send them to <to> (reserved names)')
  .requiredOption('--file <path>', 'text file, one name per line')
  .option('-a, --account <name>', 'agent account')
  .option('-y, --yes', 'no confirmation prompt')
  .option('--dry-run', 'show what would happen, change nothing')
  .action(
    run(async (to: string, o: { file: string; account?: string; yes?: boolean; dryRun?: boolean }) => {
      const { readFileSync } = await import('node:fs');
      const names = readFileSync(o.file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      if (!o.dryRun && !o.yes && !process.env.BWALLETX_YES && !(await confirm(`Cancel listings for up to ${names.length} names and send them to ${to}?`))) return console.log('Cancelled.');
      const { opnsUnlist } = await import('./opns/headless.js');
      const r = await opnsUnlist({ account: o.account, names, to, dryRun: o.dryRun });
      for (const n of r.names) console.log(n.txid ? `${n.name}: ${n.action} ${n.txid}` : n.error ? `${n.name}: FAILED ${n.error}` : `${n.name}: ${n.action}`);
      if (r.names.some((n) => n.action === 'failed')) process.exitCode = 1;
    }),
  );
opns
  .command('relist')
  .description('move our OpNS sale listings to the current tier price ($10 / $50 / $100 / $500 by length): cancel, list again')
  .option('--file <path>', 'only these names (one per line); names priced above their tier are relisted only when named here')
  .option('--all', 'every listing whose price differs from its tier (premium-priced listings are kept)')
  .option('--min-len <n>', 'only names at least this long')
  .option('--max-len <n>', 'only names at most this long')
  .option('--every <seconds>', 'pause between names (default 3, or 0.5 with --fast)')
  .option('--fast', 'one tx per name: spend the old listing straight into the new one (no unlisted gap, one fee)')
  .option('--batch <n>', 'with --fast: names per tx (1-25)', '1')
  .option('-a, --account <name>', 'agent account')
  .option('-y, --yes', 'no confirmation prompt')
  .option('--dry-run', 'count what would change and show old → new prices; build nothing')
  .action(
    run(async (o: { file?: string; all?: boolean; minLen?: string; maxLen?: string; every?: string; fast?: boolean; batch: string; account?: string; yes?: boolean; dryRun?: boolean }) => {
      if (!o.file && !o.all) throw new Error('Pass --file <names> or --all');
      const { readFileSync } = await import('node:fs');
      const names = o.file ? readFileSync(o.file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : undefined;
      const { opnsRelist } = await import('./opns/headless.js');
      const base = { account: o.account, names, all: o.all, minLen: o.minLen ? Number(o.minLen) : undefined, maxLen: o.maxLen ? Number(o.maxLen) : undefined, everyMs: o.every != null ? Number(o.every) * 1000 : undefined, fast: o.fast, batch: Number(o.batch) };
      if (o.fast && !(Number(o.batch) >= 1 && Number(o.batch) <= 25)) throw new Error('--batch must be 1-25');
      const plan = await opnsRelist({ ...base, dryRun: true });
      const head = [
        `${plan.account}: ${plan.outputs} OpNS outputs, ${plan.listed} listed · BSV $${plan.rate.toFixed(2)}`,
        `  to relist: ${plan.toChange - plan.alreadyDone} (done on earlier runs: ${plan.alreadyDone}) · already at tier: ${plan.atTier} · premium kept: ${plan.premiumKept} · out of length range: ${plan.outOfRange} · no price tag: ${plan.unknownPrice}`,
        ...plan.byLength.map((b) => `  length ${b.length}: ${b.count} × ${b.oldSats} sats (${b.oldUsd}) → ${b.newSats} sats ($${b.newUsd})`),
        plan.pendingRelist.length ? `  cancelled earlier, still to list: ${plan.pendingRelist.length}` : '',
        plan.notListed.length ? `  not listed here: ${plan.notListed.slice(0, 20).join(', ')}${plan.notListed.length > 20 ? '…' : ''}` : '',
        o.fast ? `  mode: fast, ${Number(o.batch)} name(s) per tx` : '',
        `  progress: ${plan.progress}`,
      ].filter(Boolean).join('\n');
      if (o.dryRun) return print(plan, () => head);
      console.log(head);
      const n = plan.toChange - plan.alreadyDone + plan.pendingRelist.length;
      if (!n) return console.log('Nothing to relist.');
      if (!o.yes && !process.env.BWALLETX_YES && !(await confirm(o.fast ? `Relist ${n} names (one tx per ${Number(o.batch) > 1 ? `${o.batch} names` : 'name'}, never unlisted)?` : `Cancel and relist ${n} names (two network fees each; each name is briefly unlisted)?`))) return console.log('Cancelled.');
      const r = await opnsRelist(base);
      for (const x of r.results) console.log(x.txid ? `${x.name}: ${x.action} ${x.txid}` : x.error ? `${x.name}: FAILED ${x.error}` : `${x.name}: ${x.action}`);
      if (r.stoppedBy) console.log(`Stopped: ${r.stoppedBy}. Run the same command to resume.`);
      if (r.results.some((x) => x.action === 'failed')) process.exitCode = 1;
    }),
  );
opns
  .command('sweep')
  .description('give it all back: cancel unsold listings, send every name in the agent wallet to --to, withdraw the remaining sats')
  .option('-a, --account <name>', 'agent account')
  .requiredOption('--to <address>', "owner's ordinals address for the names")
  .option('--to-pay <address>', 'address for the remaining sats (default --to)')
  .option('--names-only', 'leave the sats in the account')
  .option('--keep-listed', 'leave names that are listed for sale where they are')
  .option('-y, --yes', 'no confirmation prompt')
  .action(
    run(async (o: { account?: string; to: string; toPay?: string; namesOnly?: boolean; keepListed?: boolean; yes?: boolean }) => {
      if (!o.yes && !process.env.BWALLETX_YES && !(await confirm(`Send every OpNS name${o.keepListed ? ' not listed' : ''} in the agent account to ${o.to}${o.namesOnly ? '' : ` and the remaining sats to ${o.toPay ?? o.to}`}?`)))
        return console.log('Cancelled.');
      const { opnsSweep } = await import('./opns/headless.js');
      const r = await opnsSweep({ account: o.account, to: o.to, payTo: o.toPay, namesOnly: o.namesOnly, keepListed: o.keepListed });
      const failed = r.names.filter((n) => n.action === 'failed');
      print(r, () => `Sent ${r.names.filter((n) => n.action === 'sent').length} names to ${o.to}${r.sats ? `, ${r.sats.sats.toLocaleString()} sats (${r.sats.txid})` : ''}.${failed.map((f) => `\n  ${f.name}: ${f.error}`).join('')}`);
    }),
  );
opns
  .command('bench')
  .description('measure proof-of-work speed on this machine')
  .option('-s, --seconds <n>', 'how long', '8')
  .option('--threads <n>', 'threads (default: cores - 1)')
  .action(
    run(async (o: { seconds: string; threads?: string }) => {
      const { opnsBench } = await import('./opns/headless.js');
      const r = await opnsBench(Number(o.seconds), o.threads ? Number(o.threads) : undefined);
      print(r, () => `${r.threads} threads: ${r.mhs.toFixed(2)} MH/s · ~${r.secsPerChar.toFixed(1)} s per character on average (2^22 hashes)`);
    }),
  );

// Bare `bwalletx`: the banner, then help.
if (process.argv.length <= 2) {
  await banner();
  program.outputHelp();
} else {
  await program.parseAsync();
}
