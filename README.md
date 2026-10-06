# bwalletx: the bWalletX CLI and MCP server

Run bWalletX **agent accounts** from the command line or from any MCP client (Claude Desktop, Claude Code,
Cursor). v1 is **standalone mode**: the CLI holds one agent account's exported key file, encrypted with a
passphrase. Paired mode (scoped tokens from the app) comes later; `bwalletx login` says so.

Only agent accounts can be exported, never the main wallet. The agent account's balance is the budget.

## Install

```sh
npm i -g bwalletx      # Node 20+
```

## Pair with your phone (recommended)

Keys stay on your phone. In bWalletX (5.1.40+), open your **agent account**, then run:

```sh
bwalletx login --account phone
```

Scan the QR in the terminal from bWalletX (Settings › Paired websites › Scan to connect), check both screens show the same
4-digit code, choose what the CLI may do (see balances; buy and load strategies; send BSV) and for how long (1, 7 or 30 days),
then tap **Pair**. Every command for that account becomes an end-to-end encrypted request: bWalletX checks it against the
account's Stop switch, daily cap and loaded strategy, then signs it. Keep bWalletX open on that account while the CLI works.
Disconnect any time in the app (Settings › Paired websites) or with `bwalletx logout --account phone`.

For unattended servers where no phone is around, import a key file instead (below).

## Install (from source)

```bash
git clone <this repo> bwalletx-cli && cd bwalletx-cli
pnpm install
pnpm build
pnpm link --global      # puts `bwalletx` on your PATH (or run `node dist/cli.js`)
```

Node 20+ required.

## Import an agent account

In bWalletX: Settings › Agents › account › Export key file. Then:

```bash
bwalletx key import ./trader.key.json     # asks for the passphrase (or set BWALLETX_PASSPHRASE)
bwalletx accounts
```

The file is checked by decrypting it once, then stored still encrypted at
`~/.bwalletx/accounts/<name>.key.json` (mode 600). Keys are only decrypted in memory, when a live
transaction is signed. Set `BWALLETX_HOME` to keep state somewhere other than `~/.bwalletx`.

### Key file format (`bwalletx.agentkey/1`)

```json
{"format":"bwalletx.agentkey/1","name":"trader","identityAddress":"1…",
 "enc":{"kdf":"pbkdf2-sha256","iter":310000,"salt":"<b64 16 bytes>","iv":"<b64 12 bytes>",
        "alg":"aes-256-gcm","data":"<b64 ciphertext || 16-byte GCM tag>"}}
```

`data` decrypts to `{"payPk":WIF,"ordPk":WIF,"identityPk":WIF}`. PBKDF2-SHA256 over the UTF-8 passphrase →
AES-256-GCM, tag appended to the ciphertext exactly as WebCrypto returns it. `src/keyfile.ts`
(`encryptKeyFile` / `decryptKeyFile`) uses only `crypto.subtle`, so the app can use the same code.

## Commands

```bash
bwalletx balance --account trader                 # BSV + BSV-21 tokens, valued in USD
bwalletx price <tokenId>                          # floor price, USD per token
bwalletx send 5 richard@bwalletx.com --account trader   # $5 of BSV to a paymail or address
bwalletx buy <tokenId> --max-usd 2 --account trader
bwalletx strategy load ./accumulator.json --account trader          # paper ($100 pretend book)
bwalletx strategy load ./accumulator.json --account trader --live   # real money
bwalletx strategy show | unload
bwalletx agent run trader --interval 300          # rule-driven loop; Ctrl-C to stop
bwalletx log --account trader                     # ~/.bwalletx/log/trader.jsonl
bwalletx stop                                     # kill switch: refuse all spending
bwalletx resume
bwalletx cap trader 10                            # optional $10/day cap ("off" to clear)
bwalletx mcp                                      # stdio MCP server
```

Add `--json` for machine-readable output. `send` asks for confirmation on a terminal; `-y` skips it.

Token ids are BSV-21 ids (`txid_vout`). `send` moves BSV, so when a strategy is loaded its `rules.tokens`
must include `"BSV"`, `actions` must include `"send"`, and the recipient must be in `sendTo`.

## BRC-100 wallet for sites (`serve`)

A standalone agent account can act as a full BRC-100 wallet, so any BRC-100 site or script can use it:
launchpads, games, anything that asks for `createAction`, `signAction`, `createSignature`, `listOutputs`.

```bash
bwalletx brc100 fund      -a trader                      # move the pay address's BSV into the BRC-100 wallet
bwalletx serve            -a trader --origin www.tokenblaster.lol localhost:3000
bwalletx brc100 balance   -a trader
bwalletx brc100 withdraw all 1YourAddress… -a trader     # take it back out
```

By default the BRC-100 wallet is the CLI's own (pay-key root, `~/.bwalletx/brc100/<account>.sqlite`); fund it with
`brc100 fund`, which also collects from the receive addresses the app shows. `--shared` opens the account's own
bWalletX wallet instead (identity-key root, 1Sat Storage `https://wallet.1sat.app` as the active store). Use it only
if the app uses that remote as the account's active storage: bWallet normally keeps the phone's local store active
and only backs up every 5 minutes, so the two would drift. `brc100 migrate` moves the CLI wallet's balance into it.

`serve` listens on `http://localhost:3321`, where BRC-100 sites already look for a desktop wallet, so they
find it the same way they find BSV Desktop. Built on `@bsv/wallet-toolbox`; keys are decrypted into memory only.

- **Allowlist**: only the hosts given with `--origin` get an answer; everyone else gets 403.
- **The gate**: every `createAction` is checked like a `send` for the BSV it takes out of the account
  (its outputs minus what the site's own inputs bring in), so the kill switch, daily cap, rate limit and a
  loaded strategy all apply. Refusals reach the site as a readable wallet error.
- **Log**: every spend and signature lands in the activity log with the site and txid.
- Paired accounts can't serve: their keys stay on the phone.

## The gate

Every spending action, from the CLI, `agent run` or MCP, passes the same checks in this order:

1. **Kill switch** (`bwalletx stop`, file `~/.bwalletx/STOP`) or the account is stopped
2. **Daily cap** for the account (if set)
3. **Rate limit**: at most 30 spending actions per hour per account (paper and failed attempts count)
4. **Strategy rules** (`bwalletx.strategy/1`; same `parseStrategy` / `checkRules` / `paperFill` as the app)
5. **Paper mode** fills on the paper book and never signs

Every refusal is logged with the rule that refused it.

## Strategies

Same format as the app; see `docs/STRATEGY-FORMAT.md` in the bWalletX repo. Example:

```json
{
  "format": "bwalletx.strategy/1",
  "name": "Slow accumulator",
  "version": "1.0",
  "goals": "Build a position slowly while the price is low.",
  "rules": {
    "tokens": ["<bsv21 id txid_vout>"],
    "actions": ["buy"],
    "buyBelowUsd": 0.001,
    "maxPerTradeUsd": 2,
    "maxPerDayUsd": 10,
    "maxTotalUsd": 200,
    "stop": { "holdTokens": 100000 }
  }
}
```

`agent run` needs no AI: each tick, for every BSV-21 id in `rules.tokens`, if `buy` is allowed and the floor
price is at or below `buyBelowUsd`, it asks to buy `maxPerTradeUsd` worth. The gate decides.

## Live vs paper

| Action | Paper | Live |
| --- | --- | --- |
| balance, price, log | yes | yes (read-only) |
| send BSV (address or paymail) | yes | **yes**: P2PKH from the pay key, WhatsOnChain UTXOs, ARC (GorillaPool) broadcast with WhatsOnChain fallback; paymail via P2P destinations or basic paymentDestination |
| buy BSV-21 | yes (fills at the floor on the paper book) | **yes**: takes the cheapest whole 1Sat OrdLock (v1) listing that fits `--max-usd` and that the 1Sat overlay holds as valid; pays the seller exactly as the lock encodes, adds the 1% bWalletX market fee and (when active) the overlay fee, sends the tokens to the ord address, change to the pay address. Every input script is verified locally before broadcast. OrdLock v2 listings: not yet (use the app) |

Live sends sign with the account's key file; set `BWALLETX_PASSPHRASE` for unattended use (MCP, servers).
1-sat outputs are never spent as fee money, so ordinals and tokens on the pay address are safe.

`bwalletx buy <tokenId> --max-usd 5` shows the exact totals (seller, market fee, overlay fee, network fee) and
asks before broadcasting; `-y` or `BWALLETX_YES=1` skips the prompt. The gate sees the full dollar cost
including fees. `--dry-run` builds and verifies the purchase against the real listing with throwaway keys and
a synthetic funding coin, without touching your account or broadcasting.

## MCP

Tools: `accounts`, `balance`, `price`, `send`, `buy`, `strategy_show`, `strategy_load` (always loads in
paper mode; going live is a human step), `log`, `stop_all`. Spending tools use the gate above.

**Claude Code**

```bash
claude mcp add bwalletx -e BWALLETX_PASSPHRASE=your-passphrase-here -- bwalletx mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "bwalletx": {
      "command": "bwalletx",
      "args": ["mcp"],
      "env": { "BWALLETX_PASSPHRASE": "your-passphrase-here" }
    }
  }
}
```

Leave out `BWALLETX_PASSPHRASE` to keep MCP read-only and paper-only: live sends then fail with
"No passphrase". If `bwalletx` isn't on the PATH, use `"command": "node", "args": ["/path/to/bwalletx-cli/dist/cli.js", "mcp"]`.

## Development

```bash
pnpm build
pnpm test      # keyfile round-trip, strategy rules, gate order, rate limit, paper book, offline send signing
```

Tests use freshly generated throwaway keys only.
