// Copied from bWalletX src/mobile/names/opnsMint.ts (13 Oct 2026, bWalletX commit 4e7f6e2c). Keep behaviour identical;
// fix bugs in both places. Only import paths / platform glue differ.
import { OpNS } from '@1sat/templates';
import { OPNS_BASKET, P1SAT_PROTOCOL } from '@1sat/types';
import { buildOrdinalCustomInstructions, executeTrackedAction, type OneSatContext } from '@1sat/actions';
import { Beef, P2PKH, PublicKey, Script, Spend, Transaction, Utils, type CreateActionArgs } from '@bsv/sdk';
import { SERVICES, type Fetch } from './services.js';

/**
 * OpNS mint: one transaction per character, following the covenant's fixed layout
 * (BitcoinSchema/1sat-ordinals name-service/opns.md):
 *
 *   input 0   the live mine-tree node for the prefix (1 sat, keyless covenant unlock)
 *   input 1+  wallet funding
 *   output 0  the node restated: char marked claimed, pow = solution hash  (1 sat)
 *   output 1  the child node for prefix+char, claimed = 0x00, pow = solution  (1 sat)
 *   output 2  the name inscription prefix+char, locked to our ordinal key   (1 sat)
 *   output 3+ change (pushed raw into the unlock as "trailing outputs")
 *
 * Scripts come from @1sat/templates OpNS (lock / claimBit / buildInscription / unlock).
 * The wallet funds and signs via executeTrackedAction (createAction → signAction), so
 * the standard wallet broadcast path is used.
 */

export const OPNS_CHARSET = /^[a-z0-9-]+$/;
const OPNS_CONTENT_TYPE = 'application/op-ns';

export type MineNode = { outpoint: string; domain: string };

/**
 * One mint transaction per missing character, from the nearest claimed prefix (`domain`) to `name`.
 * Every intermediate name is minted to the miner too: mining `bmusic` from `bm` also gives `bmu`, `bmus`
 * and `bmusi` (opns.md, mine tree). Null when `name` doesn't continue `domain`.
 */
export const miningPath = (domain: string, name: string): { steps: number; alsoGet: string[] } | null => {
  if (!name.startsWith(domain) || name.length <= domain.length) return null;
  const alsoGet: string[] = [];
  for (let n = domain.length + 1; n < name.length; n++) if (n > 0) alsoGet.push(name.slice(0, n));
  return { steps: name.length - domain.length, alsoGet };
};

/** GET /1sat/opns/mine/:name → nearest mined prefix (null when the name is taken or no prefix is found). */
export const fetchMineNode = async (f: Fetch, name: string): Promise<MineNode | null> => {
  const res = await f(`${SERVICES.opnsMine}/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j?.outpoint || typeof j.domain !== 'string') return null;
  return { outpoint: String(j.outpoint), domain: j.domain };
};

export const isTaken = async (f: Fetch, name: string): Promise<boolean> => {
  const res = await f(`${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`);
  if (!res.ok) return false;
  const j = await res.json().catch(() => null);
  return !!j?.outpoint;
};

export const parseOutpoint = (op: string) => {
  const [txid, v] = op.replace('_', '.').split('.');
  return { txid, vout: Number(v) };
};

export type MintPlan = {
  char: number;
  newDomain: string;
  restated: Script;
  child: Script;
  inscription: Script;
};

/**
 * True when `char` is already claimed in a node's bitfield. The covenant OP_VERIFYs that the mined char's bit
 * was clear (bug 13 Oct 2026: re-mining "i" from the restated "dan" node e03354a0…:0, which already had "i"
 * claimed, failed at PC 2703 — the trailing change outputs had nothing to do with it).
 */
export const isCharClaimed = (claimed: number[], char: number) => {
  const byte = char >> 3;
  return byte < claimed.length && (claimed[byte] & (1 << (char & 7))) !== 0;
};

/**
 * Run the covenant locally with the SDK interpreter (same check a node does) so a transaction that would be
 * rejected is never signed off or broadcast. Throws with the interpreter's message.
 */
export const verifyCovenantSpend = (tx: Transaction, idx: number, parent: Transaction, vout: number) => {
  const input = tx.inputs[idx];
  const out = parent.outputs[vout];
  if (!input.unlockingScript) throw new Error('OpNS unlock missing');
  const spend = new Spend({
    sourceTXID: parent.id('hex'),
    sourceOutputIndex: vout,
    sourceSatoshis: out.satoshis ?? 0,
    lockingScript: out.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== idx),
    outputs: tx.outputs,
    inputIndex: idx,
    unlockingScript: input.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
  });
  let ok = false;
  try {
    ok = spend.validate();
  } catch (e) {
    throw new Error(`OpNS covenant check failed locally, not broadcast: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok) throw new Error('OpNS covenant check failed locally, not broadcast');
};

/** The three covenant-mandated outputs for mining `char` from `node` with solution `hash`. */
export const buildMintOutputs = (
  node: { claimed: number[]; domain: string },
  char: number,
  hash: number[],
  ownerScript: Script,
): MintPlan => {
  const newDomain = node.domain + String.fromCharCode(char);
  return {
    char,
    newDomain,
    restated: OpNS.lock(OpNS.claimBit(node.claimed, char), node.domain, hash),
    child: OpNS.lock([0], newDomain, hash),
    inscription: OpNS.buildInscription(newDomain, ownerScript),
  };
};

const pushLen = (n: number) => (n < 0x4c ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5) + n;
const varIntLen = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

/**
 * wallet-toolbox managed change adds up to DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION (8) P2PKH change
 * outputs per action, and every one is pushed raw into the unlock as a trailing output. The old bound
 * assumed 4: a wallet topping its change basket up (6 change outputs) made a 6405-byte unlock against a
 * declared 6337 and signAction refused it (the toolbox error prints the HEX length, 12810 = 2 × 6405).
 * 16 covers a raised per-action policy too; each spare output only costs ~34 bytes of fee (~3 sats/kB).
 */
export const MAX_TRAILING_OUTPUTS = 16;
const UNLOCK_SLACK = 64;

/**
 * Upper bound for the covenant unlock: char + nonce + ownerScript + trailing outputs
 * (`maxTrailing` P2PKH change outputs) + BIP-143 preimage (which embeds the node's script).
 * The wallet only rejects an unlock longer than this, so overestimating is safe (slightly higher fee).
 */
export const estimateUnlockLength = (
  parentScriptLen: number,
  ownerScriptLen: number,
  maxTrailing = MAX_TRAILING_OUTPUTS,
) => {
  const preimage = 4 + 32 + 32 + 36 + varIntLen(parentScriptLen) + parentScriptLen + 8 + 4 + 32 + 4 + 4;
  const trailing = maxTrailing * (8 + 1 + 25);
  return pushLen(1) + pushLen(32) + pushLen(ownerScriptLen) + pushLen(trailing) + pushLen(preimage) + UNLOCK_SLACK;
};

/** The wallet with createAction wrapped so the signable action's reference is remembered (to abort it on failure). */
const trackReference = (wallet: OneSatContext['wallet']) => {
  const seen: { reference: string | null } = { reference: null };
  const wrapped = new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === 'createAction')
        return async (args: CreateActionArgs, originator?: string) => {
          const r = await target.createAction(args, originator);
          seen.reference = r?.signableTransaction?.reference ?? null;
          return r;
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { wallet: wrapped, seen };
};

/** Fee estimate per character at `satsPerKb` (default 100 sat/kB, the wallet's usual rate). */
export const estimateMintFee = (parentScriptLen: number, satsPerKb = 100) => {
  const unlock = estimateUnlockLength(parentScriptLen, 25, 1);
  // two node outputs (~ parent size each) + inscription + funding input + change + overhead
  const bytes = 10 + (41 + unlock) + (148 + 34) + 2 * (9 + parentScriptLen + 40) + 120;
  return Math.ceil((bytes * satsPerKb) / 1000) + 3; // + the three 1-sat outputs
};

export type LoadedNode = {
  outpoint: string;
  beef: number[];
  tx: Transaction;
  vout: number;
  state: { claimed: number[]; domain: string; pow: number[] };
};

/** Load the node tx (BEEF) and decode its covenant state. */
export const loadNode = async (ctx: OneSatContext, outpoint: string, beefHint?: number[]): Promise<LoadedNode> => {
  const { txid, vout } = parseOutpoint(outpoint);
  let beef: Beef;
  if (beefHint) beef = Beef.fromBinary(beefHint);
  else {
    if (!ctx.services) throw new Error('No network services to fetch the name tree');
    beef = await ctx.services.getBeefForTxid(txid);
  }
  const tx = beef.findTxid(txid)?.tx;
  if (!tx) throw new Error('Name tree transaction not found');
  const state = OpNS.decode(tx.outputs[vout].lockingScript);
  if (!state) throw new Error('Not an OpNS node');
  return { outpoint: `${txid}.${vout}`, beef: beef.toBinary(), tx, vout, state };
};

export type MintStepResult = { txid: string; tx?: number[]; newDomain: string; childOutpoint: string };

/**
 * Build, sign and broadcast one character mint. `nonce`/`hash` come from the worker.
 * The new name's inscription goes to the wallet's OPNS basket (tag `origin` = this outpoint).
 */
export const mintStep = async (
  ctx: OneSatContext,
  node: LoadedNode,
  char: number,
  nonce: number[],
  hash: number[],
  /** CLI: lock the new name's inscription to this address (owner's vault) instead of our ordinal key. */
  lockToAddress?: string,
): Promise<MintStepResult> => {
  if (isCharClaimed(node.state.claimed, char))
    throw new Error(
      `"${String.fromCharCode(char)}" is already mined under "${node.state.domain}"; use its child node instead`,
    );
  const keyID = node.outpoint;
  let ownerScript: Script;
  if (lockToAddress) ownerScript = new P2PKH().lock(lockToAddress);
  else {
    const { publicKey } = await ctx.wallet.getPublicKey({
      protocolID: P1SAT_PROTOCOL,
      keyID,
      counterparty: 'self',
      forSelf: true,
    });
    ownerScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
  }
  const plan = buildMintOutputs(node.state, char, hash, ownerScript);
  const tags = ['opns', `type:${OPNS_CONTENT_TYPE}`, 'origin', `name:${plan.newDomain}`];
  const parentScript = node.tx.outputs[node.vout].lockingScript;

  const args: CreateActionArgs = {
    description: `Mine OpNS ${plan.newDomain}`.slice(0, 50),
    inputBEEF: node.beef,
    inputs: [
      {
        outpoint: node.outpoint,
        inputDescription: 'OpNS name tree node',
        unlockingScriptLength: estimateUnlockLength(parentScript.toBinary().length, ownerScript.toBinary().length),
      },
    ],
    outputs: [
      { lockingScript: plan.restated.toHex(), satoshis: 1, outputDescription: 'OpNS node (restated)' },
      { lockingScript: plan.child.toHex(), satoshis: 1, outputDescription: 'OpNS node (child)' },
      lockToAddress
        ? {
            // Not ours: locked straight to the owner's ordinals address, never in this wallet's basket.
            lockingScript: plan.inscription.toHex(),
            satoshis: 1,
            outputDescription: `OpNS name ${plan.newDomain} (to owner)`.slice(0, 50),
          }
        : {
            lockingScript: plan.inscription.toHex(),
            satoshis: 1,
            outputDescription: `OpNS name ${plan.newDomain}`.slice(0, 50),
            basket: OPNS_BASKET,
            tags,
            customInstructions: buildOrdinalCustomInstructions({
              protocolID: P1SAT_PROTOCOL,
              keyID,
              counterparty: 'self',
              tags,
              name: plan.newDomain,
            }),
          },
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  };

  let res: Awaited<ReturnType<typeof executeTrackedAction>>;
  const tracked = trackReference(ctx.wallet);
  try {
    res = await executeTrackedAction(tracked.wallet, args, undefined, node.beef, async (tx: Transaction) => {
      const idx = tx.inputs.findIndex(
        (i) =>
          (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === node.tx.id('hex') && i.sourceOutputIndex === node.vout,
      );
      if (idx < 0) throw new Error('Name tree input missing from the transaction');
      if (!tx.inputs[idx].sourceTransaction) tx.inputs[idx].sourceTransaction = node.tx;
      const unlock = await OpNS.unlock(char, nonce, ownerScript).sign(tx, idx);
      const declared = args.inputs?.[0]?.unlockingScriptLength ?? 0;
      if (unlock.toBinary().length > declared)
        throw new Error(
          `OpNS unlock is ${unlock.toBinary().length} bytes but ${declared} were reserved (${tx.outputs.length - 3} change outputs)`,
        );
      tx.inputs[idx].unlockingScript = unlock;
      verifyCovenantSpend(tx, idx, node.tx, node.vout);
      return { [idx]: { unlockingScript: unlock.toHex() } };
    });
  } catch (e) {
    // A rejected broadcast (e.g. WERR_REVIEW_ACTIONS on a double-spent node) must not leave a reservation behind.
    // A failed signAction (e.g. an unlock longer than reserved) carries no reference, so use the one createAction returned.
    await abortFailedAction(ctx, e, tracked.seen.reference);
    throw e;
  }
  if ('error' in res && res.error) throw new Error(String(res.error));
  if (!res.txid) throw new Error('Mint was not broadcast');
  return {
    txid: res.txid,
    tx: res.tx,
    newDomain: plan.newDomain,
    childOutpoint: `${res.txid}.1`,
  };
};

/** txid / reference of the failed action, from a wallet error (WERR_REVIEW_ACTIONS carries the txid). */
export const failedActionRef = (e: unknown): string | null => {
  const o = (e ?? {}) as { txid?: unknown; reference?: unknown; notDelayedResults?: { txid?: string }[] };
  if (typeof o.reference === 'string' && o.reference) return o.reference;
  if (typeof o.txid === 'string' && o.txid) return o.txid;
  const nd = o.notDelayedResults?.find((r) => r?.txid)?.txid;
  if (nd) return nd;
  return String(e).match(/\b[0-9a-f]{64}\b/i)?.[0] ?? null;
};

/** Best effort: release the wallet's hold on a failed mint (abortAction throws if it is already resolved). */
export const abortFailedAction = async (ctx: OneSatContext, e: unknown, fallbackRef?: string | null) => {
  const reference = failedActionRef(e) ?? fallbackRef ?? null;
  if (!reference) return;
  try {
    await ctx.wallet.abortAction({ reference });
  } catch {
    /* already failed/aborted on the wallet side */
  }
};

/** Random 27-byte nonce prefix for a mining job. */
export const randomPrefix = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(27)));

export const toHex = (b: number[]) => Utils.toHex(b);

/** " You also get bmu, bmus and bmusi." for the intermediate names a mint gives you, else ''. */
export const alsoGetText = (domain: string | null, name: string) => {
  const p = domain === null ? null : miningPath(domain, name);
  if (!p?.alsoGet.length) return '';
  const list = p.alsoGet.length === 1 ? p.alsoGet[0] : `${p.alsoGet.slice(0, -1).join(', ')} and ${p.alsoGet.at(-1)}`;
  return ` You also get ${list}.`;
};
