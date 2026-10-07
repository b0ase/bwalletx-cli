# One wallet: serve your phone's bWalletX to BRC-100 sites

`bwalletx serve --wallet paired` puts your **main** bWalletX (phone or web) behind
`http://localhost:3321`, the port BRC-100 sites probe for a desktop wallet. The CLI holds no keys:
each call goes end-to-end encrypted over the pairing relay, and the phone checks it, prompts you,
signs and broadcasts.

Status: phase 1 (read-only) and phase 2 (createAction / signAction, the phone prompts every time).
Moving funds from the CLI's own wallet into the main wallet is not part of this yet.

## User steps

1. **Pair the main wallet**

   ```
   bwalletx pair --main            # local name "main"; --account <name> to choose another
   ```

   Scan the QR in bWalletX on your main account (Settings › Paired websites › Scan to connect),
   check the 4-digit code, choose the caps, the sites and the expiry (at most 30 days), tap Pair.

2. **Serve it**

   ```
   bwalletx serve --wallet paired --origin www.tokenblaster.lol
   ```

   Keep bWalletX open and unlocked. If the phone doesn't answer within about 75 s, the site gets a
   BRC-100 error "wallet unreachable". There is **no fallback** to the CLI's local wallet.
   `--wallet local` (default) and `--wallet shared` (alias `--shared`) work as before.

3. **Revoke**

   ```
   bwalletx logout --account main
   ```

   This forgets the pairing here and tells the phone. You can also revoke it on the phone
   (Paired websites › Agent row › Revoke); the CLI then gets "Disconnected on the phone".

### What the CLI checks before anything leaves the machine

- The origin allowlist (`--origin`); other sites get 403.
- Request size (64 MB) and the method set. Forwarded: `getPublicKey`, `listOutputs`,
  `isAuthenticated`, `waitForAuthentication`, `getNetwork`, `getHeight`, `getVersion`,
  `createAction`, `signAction`. Everything else is refused locally.
- Never forwarded: `revealCounterpartyKeyLinkage`, `revealSpecificKeyLinkage`, or any call with
  `privileged: true`.
- `createAction` passes the local gate (kill switch, daily cap, rate limit, strategy) first.
- No ARC relay in paired mode: the phone broadcasts what it signs.

### Wire format

Inside the existing sealed `{ t: 'req', id, action, params }` envelope (protocol unchanged):

```json
{ "action": "brc100", "params": { "method": "createAction", "args": { ... }, "site": "www.tokenblaster.lol" } }
```

The answer is a normal `res` with `result` (the BRC-100 result) or `error { code, message }`.
`bwalletx pair --main` sends `info` with `params: { mode: "brc100" }`; the phone must answer with
`mode: "brc100"` (plus `caps`) or the CLI refuses the pairing as unsupported.

## bWalletX side (spec for the bWalletX session)

Not implemented in the CLI repo. It has to be built in bWalletX before this works end to end.

**sessions.ts**
- Accept pairings from `CLI_ORIGIN` (`https://cli.bwalletx.com`, relay-verified) with
  `scope: 'wallet'` and `{ caps, origins[], expiresAt }`, where `expiresAt` is at most 30 days away.
- `info` with `params.mode === 'brc100'` returns `{ account, identityAddress, scopes, expiresAt, mode: 'brc100', caps }`.

**agentPairing.ts**: action `'brc100'`
1. The grant exists, is not expired and has scope `wallet`.
2. `method` is in the phase 1+2 set above. Refuse linkage reveals and `privileged: true` again, even
   though the CLI already does.
3. `site` is in the grant's `origins[]`.
4. Caps: daily USD cap and per-call cap. At or under the per-call cap and inside the daily cap, follow
   the normal prompt policy (phase 2 prompts every time anyway). Over the per-call cap, always prompt.
   Over the daily cap, refuse unless the owner approves explicitly in a prompt.
5. Call `handleSiteCall` with originator `<site>.agent.bwalletx`. If the permissions manager rejects
   non-public hosts, fall back to `cli.bwalletx.com`. **Verify which one works** before shipping.
6. Append every forwarded spend/sign to an append-only spend ledger (time, site, method, sats, USD,
   txid, approved-by-prompt). The daily cap counts from this ledger.

**UI**
- Pairing sheet: caps (daily, per call), allowed sites, expiry (max 30 days).
- An "Agent" row in `PairedSitesList` showing spend today and a Revoke button.
- Activity entries labelled `agent → <site>`.

**Must-nevers**
- Keys never leave the phone.
- The CLI can't change caps, sites or expiry. Only the phone UI can.
- No key-linkage reveals and no `privileged` calls over this path.
- No spend over a cap without a prompt.
- The agent originator (`<site>.agent.bwalletx`) never reuses grants given to the real site.
