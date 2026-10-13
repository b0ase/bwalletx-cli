# Second machine for the OpNS run (laptop)

Two machines must never mine the same lists from the same account: each would spend the other's coins. So the
laptop gets its **own agent account** and its **own slice of the lists**. The split used on 13 Oct 2026:

| machine | account | lists |
|---|---|---|
| Mac mini | `opns` | opns-extra, opns-b0ase-portfolio, opns-1000-names, opns-more-tranche-* |
| laptop | `opns2` | opns-3letter-tranche-01 … 16 (15,862 names) |

Both pass the same `--vault opns-KEEP.txt --gift opns-GIFT.txt --to <owner ord> --to-pay <storefront pay>`, so a
Keep name in either slice still goes to the owner.

## On the laptop (once)

```sh
# 1. Node 22 + pnpm
brew install node && npm install -g pnpm
# 2. The CLI (opns commands are on main; the npm release does not have them yet)
git clone https://github.com/b0ase/bwalletx-cli.git ~/bwalletx-cli
cd ~/bwalletx-cli && pnpm install && pnpm build && npm link
bwalletx --version
# 3. Lists: AirDrop (or copy) from the Mac mini's ~/Desktop to the laptop's ~/Desktop:
#    opns-3letter-tranche-01.txt … 16, opns-KEEP.txt, opns-GIFT.txt
# 4. The account: on the Mac mini, bWalletX Desktop › Add agent account "opns2" (master password), then
#    Settings › Agents › opns2 › Export key file (new passphrase). AirDrop opns2.key.json to the laptop.
bwalletx key import ~/Downloads/opns2.key.json      # asks for the passphrase
bwalletx brc100 addresses -a opns2                   # first line = pay address: fund it
```

Fund opns2's pay address with **0.35 BSV** (15,862 names × ~2 chars new on average × ~1,900 sats + listing fees;
`sweep` returns what is left).

## Start the laptop

```sh
cd ~/Desktop
caffeinate -i bwalletx opns mint -a opns2 opns-3letter-tranche-*.txt \
  --vault opns-KEEP.txt --gift opns-GIFT.txt \
  --to 1HBfw7gShCV1Gw6vSrcnY9FK35P7uG7X3Z --to-pay 1F4J9KkMoqtznXPJuCgb98LRymssc8MFfd \
  --budget 35000000
```

## Take the 3-letter names off the Mac mini

Ctrl-C the Mac mini's run, then restart it **without** the 3-letter files and with `--prune`, which drops the
names still to do that are no longer in its lists (done ones stay):

```sh
cd ~/Desktop
caffeinate -i bwalletx opns mint -a opns --prune opns-extra.txt opns-b0ase-portfolio.txt opns-1000-names.txt opns-more-tranche-*.txt \
  --vault opns-KEEP.txt --gift opns-GIFT.txt \
  --to 1HBfw7gShCV1Gw6vSrcnY9FK35P7uG7X3Z --to-pay 1F4J9KkMoqtznXPJuCgb98LRymssc8MFfd \
  --budget 72000000
```

Do the Mac mini restart **before** the laptop starts, so no 3-letter name is mined twice (the second would be
"taken", a wasted minute, nothing worse).

`bwalletx opns status -a opns2` on the laptop and `-a opns` on the Mac mini show each side's progress.
