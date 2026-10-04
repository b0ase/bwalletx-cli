/** `bwalletx mcp`: stdio MCP server exposing the same operations, through the same gate. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as act from './actions.js';
import { appendLog, getLoaded, readConfig, resolveAccount, setAllStopped } from './store.js';

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

  await server.connect(new StdioServerTransport());
}
