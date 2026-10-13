# OpNS headless batch minting: owner runbook

Mint every name in your lists in the background from **one** agent account: no browser, no Resume button.
The agent account is your own sub-account. Its keys stay on your Mac (encrypted key file, decrypted into
memory only while the CLI runs). No bWalletX server ever holds your money or your names.

What happens to each name (alphabetical order, so `b0as` is mined before `b0ase` and its characters are reused):

| List | Minted to | Listed for sale? |
| --- | --- | --- |
| `--vault opns-KEEP.txt`, `--gift opns-GIFT.txt` | straight to your ordinals address (`--to`) | never |
| every other list | the agent account | yes, OrdLock v2: 5+ chars **$1**, 4 chars **$5**, 3 chars **$15** (USD → sats at the live rate when listed) |

Each name is re-checked right before it is mined: taken by someone else → skipped. Every transaction runs the
OpNS covenant locally (the same script check a node does) before it is broadcast; if that or the wallet fails, the
run stops and nothing bad is sent.

## 1. Create and fund the agent account (once)

1. bWalletX Desktop › account menu › **Add agent account** (name it `opns`). Set its budget.
2. Settings › Agents › `opns` › **Export key file** (Connect CLI & MCP). Pick a passphrase. Save `opns.key.json`.
3. On the Mac:
   ```sh
   bwalletx key import ~/Downloads/opns.key.json     # asks for the passphrase
   bwalletx brc100 addresses -a opns                  # the first line is the pay address
   ```
4. From your main wallet, **send 0.72 BSV to that pay address** (a normal send to an address). The minter moves
   it into the account's own BRC-100 wallet when it starts (`bwalletx brc100 fund -a opns` does the same by hand).

0.72 BSV covers all current lists with ~5% margin: ~34,200 characters to mine × ~1,881 sats (≈ 0.643 BSV) plus
~22,650 listings × 200 sats (≈ 0.045 BSV). Anything left over comes back with `sweep`.

## 2. Start it

```sh
cd ~/Desktop
export BWALLETX_PASSPHRASE='your-passphrase-here'   # unattended: no prompt
caffeinate -i bwalletx opns mint -a opns \
  opns-1000-names.txt opns-3letter-tranche-*.txt opns-more-tranche-*.txt \
  --vault opns-KEEP.txt --gift opns-GIFT.txt \
  --to <your ordinals address> --to-pay <your BSV address> \
  --budget 72000000
```

- `--to`: your main wallet's ordinals address. KEEP and GIFT names are locked straight to it.
- `--to-pay` (optional): sale proceeds pay straight to this address. Leave it out to collect them in the agent account.
- `--budget`: the most this job may spend, in sats. The run stops cleanly before a name that would go over it.
- `caffeinate -i` keeps the Mac awake. Proof of work uses all cores but one (`--threads N` to change).
- The live line shows names done, listed, sent to you, taken, sats spent and the ETA.

## 3. Watch, stop, resume

```sh
bwalletx opns status -a opns          # from another terminal, any time
open ~/.bwalletx/opns-batch-opns.html # progress page (refreshes every 30 s) with every txid
```

- **Stop**: Ctrl-C once. The current name is left pending and everything is saved
  (`~/.bwalletx/opns-batch-opns.json`). Ctrl-C twice quits at once; that is safe too.
- **Resume**: run the same command again. It continues exactly where it stopped; characters already mined are
  reused (`~/.bwalletx/opns-tree-opns.json`) and no name is ever mined twice. Add new lists to the same command
  any time: new names are merged in.
- **Out of budget / low balance**: send more BSV to the pay address, then rerun with a higher `--budget`.
- **Emergency stop**: `bwalletx stop` (kill switch for every account), `bwalletx resume` to allow spending again.
- **It stopped with an error**: the message says which name. Rerun to retry; a failed listing never stops minting
  and is retried at the end of each run.

## 4. Sweep (whenever you want)

```sh
bwalletx opns sweep -a opns --to <your ordinals address> --to-pay <your BSV address>
```

Cancels unsold listings, sends every name still in the agent account to `--to`, then sends the remaining sats to
`--to-pay` (or `--to`). `--keep-listed` leaves listed names on sale; `--names-only` leaves the sats.

## Time

Measured on this Mac (Apple M4, 10 cores): **9.3 MH/s with 9 threads** (`bwalletx opns bench`), so proof of work is
about **0.5 s per character** on average (2^22 hashes). Signing and broadcasting a ~19 kB mint and the indexer
checks add roughly 2–3 s per character, and a listing about 2 s. Rough estimates:

| Tranche | Names | Characters | Time |
| --- | --- | --- | --- |
| `opns-3letter-tranche-NN` | 1,000 | ~1,000 | ~1.5 h |
| `opns-more-tranche-NN` | 1,000 | ~3,000–3,600 | ~3–3.5 h |
| `opns-1000-names` | 1,000 | ~2,800 | ~3 h |
| KEEP + GIFT not in other lists | ~150 free | ~650 | ~0.5 h |
| **all lists** | ~23,000 | ~34,200 | **~40 h** |

`bwalletx opns status` replaces these guesses with the real seconds per character after the first names.
