/**
 * `bwalletx mcp`: stdio MCP server exposing the same operations, through the same gate.
 *
 * Human-only (never exposed here, by design): `cap` changes, `resume`, `strategy load --live`, `key import`,
 * `pair` / `login` / `logout`, `brc100 migrate`, and starting/stopping `serve`. These change safety settings,
 * trust or key material, or need a person at the terminal/phone; an agent may stop things (`stop_all`) but
 * never loosen them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as act from './actions.js';
import * as b1 from './brc100Actions.js';
import * as mint from './mint.js';
import { allStopped, appendLog, getLoaded, readConfig, resolveAccount, setAllStopped } from './store.js';

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const wrap =
  <A>(fn: (a: A) => Promise<unknown> | unknown) =>
  async (a: A) => {
    try {
      return json(await fn(a));
    } catch (e) {
      return { ...json({ error: e instanceof Error ? e.message : String(e) }), isError: true };
    }
  };

export async function runMcp(version: string) {
  const server = new McpServer({ name: 'bwalletx', version });
  const account = z.string().optional().describe('Account name (default: the default account)');

  server.registerTool('accounts', { description: 'List bWalletX agent accounts imported into this CLI, with loaded strategies.' }, wrap(() => act.listAccounts()));
  server.registerTool(
    'balance',
    { description: 'BSV and BSV-21 token balances of an agent account, in USD.', inputSchema: { account } },
    wrap(({ account: a }: { account?: string }) => act.balance(a)),
  );
  server.registerTool(
    'price',
    { description: 'Floor price of a BSV-21 token (USD and sats per token) from live listings.', inputSchema: { tokenId: z.string().describe('BSV-21 id, txid_vout') } },
    wrap(({ tokenId }: { tokenId: string }) => act.price(tokenId)),
  );
  server.registerTool(
    'send',
    {
      description:
        'Send BSV worth `usd` dollars to an address or paymail. Gated: kill switch, daily cap, rate limit, strategy rules (token "BSV" and sendTo must allow it). Paper mode never signs. Live needs BWALLETX_PASSPHRASE in the server env (key-file accounts) or a paired phone with bWalletX open.',
      inputSchema: { usd: z.number().positive(), to: z.string(), account },
    },
    wrap(({ usd, to, account: a }: { usd: number; to: string; account?: string }) => act.send(usd, to, a)),
  );
  server.registerTool(
    'buy',
    {
      description:
        'Buy a BSV-21 token for at most maxUsd: the cheapest whole buyable 1Sat listing that fits, plus the 1% bWalletX market fee. Gated like send. Paper mode fills on the paper book; live signs and broadcasts (key-file accounts need BWALLETX_PASSPHRASE; paired accounts are signed on the phone).',
      inputSchema: { tokenId: z.string(), maxUsd: z.number().positive(), account },
    },
    wrap(async ({ tokenId, maxUsd, account: a }: { tokenId: string; maxUsd: number; account?: string }) => {
      const name = resolveAccount(a).name;
      const paired = resolveAccount(a).kind === 'paired'; // the phone signs: no passphrase here
      if (!paired && getLoaded(name)?.mode !== 'paper' && !process.env.BWALLETX_PASSPHRASE) return { ok: false, text: 'Live buy needs BWALLETX_PASSPHRASE in the MCP server env' };
      return act.buy(tokenId, maxUsd, name);
    }),
  );
  server.registerTool(
    'strategy_show',
    { description: 'Show the strategy loaded into an account (rules, mode, paper book).', inputSchema: { account } },
    wrap(({ account: a }: { account?: string }) => act.strategyShow(a)),
  );
  server.registerTool(
    'strategy_load',
    {
      description: 'Load a bwalletx.strategy/1 file (path on this machine) into an account. Always loads in PAPER mode from MCP; switching to live is a human step (`bwalletx strategy load --live`).',
      inputSchema: { file: z.string(), account },
    },
    wrap(({ file, account: a }: { file: string; account?: string }) => act.strategyLoad(file, a, false)),
  );
  server.registerTool(
    'log',
    { description: 'Recent activity log entries for an account (newest last).', inputSchema: { account, limit: z.number().int().positive().max(500).optional() } },
    wrap(({ account: a, limit }: { account?: string; limit?: number }) => act.log(a, limit ?? 50)),
  );
  server.registerTool(
    'stop_all',
    { description: 'Kill switch: stop every agent account. Every spending action is refused until a human runs `bwalletx resume`.' },
    wrap(() => {
      setAllStopped(true);
      for (const n of Object.keys(readConfig().accounts)) appendLog(n, { at: Date.now(), action: 'stop', detail: 'All agents stopped (MCP)', usd: 0 });
      return { stopped: true };
    }),
  );

  const wallet = z.enum(['local', 'shared']).optional().describe("local (default): the CLI's own BRC-100 wallet; shared: the account's 1Sat Storage wallet (only if the app uses it as active storage)");
  const isShared = (w?: string) => w === 'shared';
  server.registerTool(
    'brc100_balance',
    { description: "Spendable BSV in a key-file account's BRC-100 wallet (read-only). Needs BWALLETX_PASSPHRASE to open the wallet; paired accounts are refused (keys on the phone).", inputSchema: { account, wallet } },
    wrap(({ account: a, wallet: w }: { account?: string; wallet?: 'local' | 'shared' }) => b1.brc100Balance(a, isShared(w))),
  );
  server.registerTool(
    'brc100_addresses',
    { description: "Addresses a key-file account takes BSV in at: its pay address and the bWalletX app's receive addresses (read-only). Refused for paired accounts.", inputSchema: { account } },
    wrap(({ account: a }: { account?: string }) => b1.brc100Addresses(a)),
  );
  server.registerTool(
    'brc100_fund',
    {
      description:
        "Move the account's own plain BSV (pay address + app receive addresses) into its own BRC-100 wallet. No money leaves the account; logged as brc100-fund. Refused while all agents are stopped. Needs BWALLETX_PASSPHRASE.",
      inputSchema: { account, wallet },
    },
    wrap(async ({ account: a, wallet: w }: { account?: string; wallet?: 'local' | 'shared' }) => {
      if (allStopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
      const r = await b1.brc100Fund(a, isShared(w));
      return { account: r.name, ...r.result };
    }),
  );
  server.registerTool(
    'brc100_withdraw',
    {
      description:
        'Send BSV worth `usd` dollars ("all" for everything) from the BRC-100 wallet to an address. Gated like send: kill switch, daily cap, rate limit, strategy rules; paper mode refuses (nothing signed). Logged; relayed to ARC. Needs BWALLETX_PASSPHRASE.',
      inputSchema: { usd: z.union([z.number().positive(), z.literal('all')]), address: z.string(), account, wallet },
    },
    wrap(({ usd, address, account: a, wallet: w }: { usd: number | 'all'; address: string; account?: string; wallet?: 'local' | 'shared' }) => b1.brc100Withdraw(usd, address, a, isShared(w))),
  );
  const mintOpts = {
    account: z.string().optional().describe('Paired account (pairing scope "Mint NFTs")'),
    collection: z.string().optional().describe('Create this collection with the first item and add the rest to it'),
    collectionId: z.string().optional().describe('Add to an existing collection of yours (<txid>_<vout>)'),
    description: z.string().optional().describe('Description for every item'),
    dryRun: z.boolean().optional().describe('Sizes and cost estimate only; nothing is sent'),
  };
  type MintArgs = { account?: string; collection?: string; collectionId?: string; description?: string; dryRun?: boolean };
  const mintGate = (o: MintArgs) => (!o.dryRun && allStopped() ? 'Refused: all agents are stopped (bwalletx resume)' : null);
  server.registerTool(
    'mint',
    {
      description:
        'Mint files (paths on this machine) as NFTs on a paired phone, like `bwalletx mint`. The phone signs within the mint limits chosen when pairing (items and USD); refused while all agents are stopped. Key-file accounts cannot mint.',
      inputSchema: { files: z.array(z.string()).min(1), title: z.string().optional().describe('Title (one file only)'), titleFromFilename: z.boolean().optional(), ...mintOpts },
    },
    wrap(async (o: MintArgs & { files: string[]; title?: string; titleFromFilename?: boolean }) => {
      const refused = mintGate(o);
      if (refused) return { ok: false, text: refused };
      return mint.runMint(mint.itemsFor(o.files, o), { account: o.account, collection: mint.collectionOf(o), description: o.description, dryRun: o.dryRun, out: () => {} });
    }),
  );
  server.registerTool(
    'mint_manifest',
    {
      description: 'Mint every entry of a manifest file ([{ title, file, sha256? }]) in order on a paired phone, like `bwalletx mint-manifest`; resumable via <manifest>.progress.json. Same limits as mint.',
      inputSchema: { manifest: z.string(), ...mintOpts },
    },
    wrap(async (o: MintArgs & { manifest: string }) => {
      const refused = mintGate(o);
      if (refused) return { ok: false, text: refused };
      const progressPath = mint.progressPathFor(o.manifest);
      const r = await mint.runMint(mint.readManifest(o.manifest), { account: o.account, collection: mint.collectionOf(o), description: o.description, dryRun: o.dryRun, progressPath, out: () => {} });
      return o.dryRun ? r : { ...r, progressPath };
    }),
  );
  server.registerTool(
    'pairing_status',
    { description: 'Whether an account is paired with a phone and in which mode (agent, or brc100 main wallet), with scopes, expiry and mint/caps limits (read-only, never secrets). Pairing itself is a human step (`bwalletx login` / `pair --main`).', inputSchema: { account } },
    wrap(({ account: a }: { account?: string }) => b1.pairingStatus(a)),
  );
  server.registerTool(
    'serve_status',
    { description: 'Whether something is listening on the `bwalletx serve` BRC-100 port (default 3321) (read-only). Starting/stopping serve is a human step.', inputSchema: { port: z.number().int().positive().max(65535).optional() } },
    wrap(({ port }: { port?: number }) => b1.serveStatus(port ?? 3321)),
  );

  await server.connect(new StdioServerTransport());
}
