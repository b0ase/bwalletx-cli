#!/usr/bin/env bash
# bMovies agent, Phase 0: make the @bmovies agent wallet ON THE HETZNER SERVER. The owner runs this by hand.
#
#   ssh hetzner
#   curl -fsSL https://raw.githubusercontent.com/b0ase/bwalletx-cli/<branch>/scripts/bmovies-agent-setup.sh -o /tmp/bmovies-agent-setup.sh
#   less /tmp/bmovies-agent-setup.sh          # read it first
#   sudo bash /tmp/bmovies-agent-setup.sh
#
# What it does:
#   1. Installs bwalletx-cli under /opt/bmovies-agent (Node 20+; uses Docker node:22 if the host Node is older).
#   2. `bwalletx key new bmovies`: three new keys, encrypted with a passphrase YOU type (asked twice, never stored,
#      never on the command line). The encrypted key file stays on this server only (mode 600).
#   3. Daily cap £1 (as $1.30) and owner approval for any single spend over 10p (as $0.13).
#   4. Prints ONLY public values: the identity key, the receive (pay) address and its public key. Send those to Claude.
#
# It never prints, copies or uploads a private key. It refuses to run if a "bmovies" account already exists.
# Back up /opt/bmovies-agent/bmovies.key.json (it is encrypted) somewhere offline; without it and the
# passphrase the funds are gone. Withdrawals are owner-only; the agent never sweeps.
set -euo pipefail

AGENT_DIR=/opt/bmovies-agent
BRANCH="${BWALLETX_CLI_BRANCH:-main}"
REPO=https://github.com/bitcoin-corp/bwalletx-cli.git
CAP_USD=1.30        # £1 a day
APPROVE_ABOVE_USD=0.13  # 10p
export BWALLETX_HOME="$AGENT_DIR/home"
unset BWALLETX_PASSPHRASE   # always prompt; never take it from the environment

umask 077
mkdir -p "$AGENT_DIR" "$BWALLETX_HOME"
chmod 700 "$AGENT_DIR" "$BWALLETX_HOME"

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" -ge 20 ]; then
  run_node() { (cd "$AGENT_DIR/bwalletx-cli" && node "$@"); }
  run_build() { (cd "$AGENT_DIR/bwalletx-cli" && corepack enable >/dev/null 2>&1 || true; pnpm install --frozen-lockfile && pnpm build); }
else
  command -v docker >/dev/null 2>&1 || { echo "Need Node 20+ or Docker on this host." >&2; exit 1; }
  echo "Host Node is $(node -v 2>/dev/null || echo missing); using Docker node:22."
  DOCKER=(docker run --rm -i -v "$AGENT_DIR:$AGENT_DIR" -e BWALLETX_HOME -w "$AGENT_DIR/bwalletx-cli" node:22-bookworm-slim)
  [ -t 0 ] && DOCKER=(docker run --rm -it -v "$AGENT_DIR:$AGENT_DIR" -e BWALLETX_HOME -w "$AGENT_DIR/bwalletx-cli" node:22-bookworm-slim)
  run_node() { "${DOCKER[@]}" node "$@"; }
  run_build() { "${DOCKER[@]}" sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm build'; }
fi

if [ -d "$AGENT_DIR/bwalletx-cli/.git" ]; then
  git -C "$AGENT_DIR/bwalletx-cli" fetch -q origin "$BRANCH"
  git -C "$AGENT_DIR/bwalletx-cli" checkout -q "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$AGENT_DIR/bwalletx-cli"
fi
echo "Building bwalletx-cli ($BRANCH)…"
run_build >/dev/null

bwx() { run_node dist/cli.js "$@"; }

if bwx --json accounts | grep -q '"name": "bmovies"'; then
  echo "A \"bmovies\" agent account already exists here. Not touching it." >&2
  bwx key info bmovies
  exit 1
fi

echo
echo "Choose a passphrase for the @bmovies agent key (8+ characters). You will need it to start the agent."
bwx key new bmovies --out "$AGENT_DIR/bmovies.key.json" >/dev/null
chmod 600 "$AGENT_DIR/bmovies.key.json"
bwx cap bmovies "$CAP_USD" >/dev/null
bwx approve-above bmovies "$APPROVE_ABOVE_USD" >/dev/null

echo
echo "Done. Send these three PUBLIC values to Claude (nothing else):"
bwx --json key info bmovies | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);console.log("  identity key:    "+i.identityKey);console.log("  receive address: "+i.payAddress);console.log("  receive pubkey:  "+i.payPubkey)})' 2>/dev/null \
  || bwx key info bmovies | grep -E 'identity key|pay address|pay pubkey'
echo
echo "Cap: \$$CAP_USD/day (£1). Owner approval above \$$APPROVE_ABOVE_USD (10p)."
echo "Back up $AGENT_DIR/bmovies.key.json (encrypted) offline. Do not share the passphrase."
