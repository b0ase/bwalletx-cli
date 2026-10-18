# CLI ↔ agent account sync: security and robustness review (18 Oct 2026)

Scope: how an agent account's keys and state get from bWalletX (`b0ase/yours-mobile`, branch `bwallet`)
to the `bwalletx` CLI (`bitcoin-corp/bwalletx-cli`, main at 6efa0f6) and stay in step. That covers key
export/import, pairing, `serve`, spending limits, and running many accounts at once. No key files,
passphrases or seeds were read, and nothing was signed or broadcast.

## How it works today

There are three ways to connect, each with a different trust model:

| Mode | Keys live | Who enforces the caps | Link to the app |
|---|---|---|---|
| **Key file** (`key import`, `key new`) | CLI disk (encrypted) + CLI memory while running | The CLI only (`gate.ts`), from its own `config.json` and log | None after export |
| **Paired agent** (`bwalletx login`) | Phone only | The phone (`checkAgentAction`), plus scopes and an expiry of 30 days or less | E2E-encrypted relay `relay.bwallet.space` |
| **Paired main / brc100** (`login --main`, `serve --wallet paired`) | Phone only | The phone (when it supports this; no phone-side handler exists on `bwallet` yet) | Same relay |

The BRC-100 wallet the CLI opens for a key-file account (`brc100.ts`) uses local SQLite by default.
`--shared` uses 1Sat Storage (`wallet.1sat.app`) instead, which is the remote the app can also use.

## Findings (most severe first)

### H1. Parallel spends could exceed the daily cap (CLI). **Fixed, PR #7**
`gate.ts:102` reads the log, decides, and returns. The spend is logged only after signing
(`actions.ts` send/buy, `brc100Actions.ts:82`, `brc100.ts:453`). Two processes on one account, such
as `agent run` plus MCP, or `opns` plus `serve`, could both pass the cap before either was logged. So
could two parallel `serve` requests, because `localBackend` is not serialised.
**Fix:** `store.withSpendLock(account)` holds an atomic `mkdir` lock across processes and a promise
chain inside one process, so gate → sign → log runs as one step. A stale lock (over 10 minutes) is
taken over. The lock wraps `send`, `buy`, `withdrawFrom` and `serve` `createAction`/`signAction`.

### H2. `serve` cap bypass through the wallet's own coins named as inputs (CLI). **Fixed, PR #7**
`outgoingSats` (`brc100.ts:234`) subtracts the value of every `args.inputs` outpoint found in the
caller's `inputBEEF`. Any allowlisted site could call `listOutputs` (which is allowed), then name the
wallet's **own** coins as inputs with their BEEF. The result was `outgoingSats = 0`, so the gate saw
$0 and the site could drain the account past the cap, the approval threshold and the rate limit.
**Fix:** `ServeWallet.owned()` returns the wallet's spendable default-basket outpoints, and
`outgoingSats(args, owned)` no longer counts those as caller-brought. If the wallet can't be read, the
call is refused (fail closed).

### H3. Parallel paired buy/send could exceed the cap (phone). **Fixed, yours-mobile PR #246**
`agentPairing.ts` `handleAgentCall` serialised `mint` but not `buy`/`send`, which have the same
check-then-log race. They now share mint's serial queue.

### H4. Caps and Stop set in the app don't reach a key-file account (design gap, not fixed)
The key file (`keyfile.ts`) carries only keys. `importKey` (`actions.ts:69`) sets
`dailyCapUsd: prev?.dailyCapUsd ?? null`, so a freshly imported account has **no cap**. Neither the
app's Stop nor its budget ever reaches the CLI, and nothing syncs back afterwards. The same applies when
the app is offline: CLI enforcement is whatever is in `~/.bwalletx/config.json`.
Also, in key-file mode **every CLI cap is advisory**. Anyone holding the file and the passphrase can
sign with any tool. The caps only protect against a buggy or compromised agent *program* that goes
through the CLI.
Recommendation: use paired mode for anything that must enforce limits. For key-file mode, (a) make
import refuse to go live until `bwalletx cap` is set, or default the cap to a small value, and (b) add an
optional signed policy (cap, stop, expiry) to the export, signed by the main identity key and checked
at import.

### M1. `BWALLETX_PASSPHRASE` in the environment (CLI)
`passphrase.ts:5`. Long-running `serve`, `agent run`, MCP and `opns batch` processes keep the passphrase
in their environment, so any child process inherits it and it can be read by the same user (and by root).
The decrypted WIFs also stay in memory for the life of `serve`/`opns`. This is acceptable for a
dedicated box, but should be documented. Suggest: support `BWALLETX_PASSPHRASE_FILE` (mode 600), and
`delete process.env.BWALLETX_PASSPHRASE` after first read in long-running commands.

### M2. Pairing: the CLI side accepts the phone's key without confirmation
`paired.ts` `round()`. The phone's `hello` key is unauthenticated. A malicious relay can't read or
forge the phone's traffic, because the phone uses the site key from the QR. It *can*, however,
impersonate the phone to the CLI: the CLI saves a pairing with the relay's key and shows a 4-digit
code that won't match the phone's. Nothing makes the user compare the codes. Impact: fake balances and
answers on the CLI, and the CLI's requests never reach the phone. **No funds at risk** (the phone signs
everything). Suggest: require Enter or "y" after "codes match?" before saving.
The relay also sees metadata: channel, frame sizes, timing and the CLI origin header.

### M3. Pairing: unpairing is best-effort; the pairing file is a bearer credential
`unpair()` sends `close` only if the relay and phone are reachable. Otherwise the phone keeps honouring
the grant until it expires (up to 30 days). `~/.bwalletx/paired/<name>.json` (mode 600) holds the
session key `s`. Whoever copies it can make in-scope calls until expiry, limited by the phone's caps.
Revoke from the phone (Settings › Paired websites) when a machine is lost. Suggest: a shorter default
expiry for agent grants, and a "last seen from" record on the phone.

### M4. Two processes on one pairing will desync counters
`PhoneSession.persist()` does read-modify-write of `sent`/`lastSeen` without a lock. Two CLIs on one
pairing reuse sequence numbers, and the phone drops the replays, which looks like "No answer from your
phone". This is not a security issue: GCM nonces are random, and replay protection works as designed.
For armies, use one pairing per process.

### M5. A post-broadcast failure was logged as $0 (CLI). **Fixed, PR #7**
When `broadcast()` threw (for example on a timeout) after the signed tx had been handed to ARC or
WhatsOnChain, the tx could still be mined, but the log said `usd: 0`, so the cap didn't count it. Such
failures now log the amount, with a note.

### M6. `opns batch` uses its own sats budget, not the daily cap
`opns/headless.ts:107` honours Stop and per-account `stopped`, plus `--budget`, but not
`dailyCapUsd`/`approveAboveUsd`. This is intentional for minting runs. Note that it is a separate limit.

### L1. A bad relay frame crashed the CLI. **Fixed, PR #6**
`JSON.parse` inside the websocket handlers threw an unhandled rejection, which ends Node. The phone
`hello` key wasn't validated before ECDH either. Both are now guarded (`parseFrame`).

### L2. App-exported names with spaces were refused at import. **Fixed, PR #6**
The app writes the display name (`ExportForCli.tsx`), and the CLI required `[A-Za-z0-9._-]{1,40}`.
Import now slugs the name. The existing-identity check is unchanged.

### L3. `serve` origin check
`brc100.ts:392` trusts the `Origin`/`Originator` header. Browsers can't forge it, but any local process
can. Treat `serve` as "every program on this machine may spend up to the cap". It binds to 127.0.0.1
only (good). `--origin '*'` is accepted. Suggest refusing `*` unless `--yes-any-origin` is given.

### Looks right
- Key file: PBKDF2-SHA256 310k iterations, 16-byte salt, AES-256-GCM, 12-byte random IV, and the tag is
  verified. A wrong passphrase gives a clean "Wrong passphrase or damaged key file" with no partial
  output. The iteration count is bounded at 100k to 10M, which stops a DoS from a hostile file. Files
  are written 0600 and directories 0700. The app requires a passphrase of 10+ characters (the CLI's own
  `key new` requires 8+).
  Possible upgrade later: Argon2id or scrypt, for GPU resistance.
- Pairing crypto: ECDH secp256k1 → HKDF (channel salt, versioned info) → AES-GCM. The AAD binds the
  role and the sequence number, so reflection and replay are rejected, and counters persist across
  restarts. Only `CLI_ORIGIN` sockets get agent grants, and those are scoped, expire and are bound to
  one agent account. `strategy_load` from a computer is paper only.
- Paired `serve` never forwards privileged or key-linkage calls.
- Reorgs: `proofRepair` (e472417) re-proves proofs from orphaned blocks in the local SQLite wallet.
  With `--shared`, the storage server owns this.
- Double-spend of UTXOs: the local SQLite toolbox reserves outputs per action. The P2PKH `send`/`buy`
  path picks WhatsOnChain UTXOs with no reservation. The new spend lock serialises it per account, but
  a key-file account used **at the same time from the app** (same pay address) can still collide. The
  result is a rejected tx, not a loss.

## Armies of agents, and b

**Isolation.** One account per agent: its own key file (or pairing), log, strategy, lock and SQLite
store. `BWALLETX_HOME` per process keeps them fully separate. Today's keys are independent random keys
(`key new`), or app agent accounts derived from the user's seed. For hundreds of agents, derive each
from the owner's seed on the phone (BRC-42 child keys, `agent/<n>`). That gives recovery from the seed,
a sweep with no file juggling, and lets the app list them all. Never put the seed on the box.

**Bulk management.** This doesn't exist yet. The proposed design (no code yet):
- `bwalletx fleet create --count N --prefix bot --cap 2 --approve-above 1` creates N accounts with caps
  set *before* they can go live.
- `fleet fund --each 1usd` pays from one funding account (itself capped) to each pay address.
- `fleet cap|stop|resume <glob>` and a single `STOP` file already stop every agent on a box.
- `fleet sweep --to <main>` sends everything back, logged.
- Shared services (WhatsOnChain, ARC, 1Sat, the relay at 60 frames/min per channel) need one
  per-box token bucket, not per process. Today each process retries 429s independently.

**Where the limits must live.** For many agents, limits must be enforced by something the agent can't
edit:
1. **Paired mode**: the phone holds keys and caps. This doesn't scale to hundreds while the phone must
   be open on that account, but it is the right model.
2. **A co-signer policy service**: each agent key is a 2-of-2 with a policy server holding a cap. The
   server signs only within cap/stop/expiry, and the owner's phone can revoke it.
3. Key-file mode with CLI caps, for small or disposable balances only.

**Can b orchestrate them safely?** Yes, if b never holds keys and only holds a *capability*:
- The owner grants b a delegation on the phone: a list of agent accounts, a total budget per day, a
  per-action limit, an expiry, and allowed actions (`fund`, `cap`, `stop`, `sweep`-to-owner only).
  The grant is signed by the owner's identity key and revocable in one tap.
- b calls a narrow API (the existing MCP tool set is close). Each call carries the grant and is checked
  where the money is: the phone, or the co-signer. b's own prompt or code is never trusted.
- b can always *stop*, because stopping is free. Raising caps, adding accounts or sending anywhere but
  back to the owner needs a fresh phone approval (one-sheet permissions).
- Everything b does is logged to the agent log and visible in the app.

This is the same shape as the paired-CLI grant (scopes, expiry, one account), extended to many accounts
and a shared budget.

## PRs
- bwalletx-cli #6: L1 and L2 (small; ready to merge).
- bwalletx-cli #7: H1, H2 and M5, plus this report (**money path: owner review, do not auto-merge**).
- yours-mobile #246: H3 (**money path: owner review**).
