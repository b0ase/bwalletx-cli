/**
 * Fetch merkle proofs for the wallet's own unproven transactions (23 Oct 2026).
 *
 * `opns relist --fast` chains change-spending txs. They confirmed on chain, but the CLI's wallet store never
 * learned that: the toolbox's TaskCheckForProofs only runs when a new-block-header event sets `checkNow`, and
 * `monitor.lastNewHeader` (its max acceptable height) is only set by that event, which the CLI's short-lived
 * monitor never sees. So every tx stayed "unproven", createAction walked the whole ancestry for its BEEF and
 * threw `WERR_INVALID_OPERATION: Maximum BEEF depth exceeded. Limit is 12`.
 *
 * Sync: read the chain tip, hand it to the monitor as a new block header (sets lastNewHeader + checkNow), run
 * CheckForProofs and CheckNoSends once, then ReviewStatus so the transactions are marked completed. Read-only
 * network lookups; nothing is signed or broadcast.
 */

export type SyncDeps = {
  /** Wallet proof requests still waiting for a proof. */
  unproven: () => Promise<number>;
  /** Chain tip header from the monitor's chain tracker. */
  tip: () => Promise<{ height: number; hash: string }>;
  /** monitor.processNewBlockHeader */
  newHeader: (h: { height: number; hash: string }) => void;
  /** monitor.runTask */
  runTask: (name: string) => Promise<string>;
};

export type SyncResult = { height: number; before: number; after: number; proven: number };

export const PROOF_TASKS = ['CheckForProofs', 'CheckNoSends', 'ReviewStatus'] as const;

export const syncProofs = async (d: SyncDeps): Promise<SyncResult> => {
  const before = await d.unproven();
  const tip = await d.tip();
  if (before === 0) return { height: tip.height, before, after: 0, proven: 0 };
  d.newHeader(tip);
  for (const t of PROOF_TASKS) await d.runTask(t);
  const after = await d.unproven();
  return { height: tip.height, before, after, proven: Math.max(0, before - after) };
};

export const describeSync = (r: SyncResult) =>
  r.before === 0
    ? `proof sync: nothing unproven (tip ${r.height})`
    : `proof sync: ${r.proven} of ${r.before} unproven tx(s) proven at tip ${r.height}${r.after ? `, ${r.after} still waiting (not mined yet?)` : ''}`;

/** createAction refused because the unproven ancestry is too deep (toolbox getBeefForTransaction). */
export const isBeefDepth = (msg: string) => /Maximum BEEF depth exceeded/i.test(msg);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Run a wallet spend; if it fails with the BEEF-depth error (thrown, or returned as `{ error }` by @1sat/actions),
 * fetch proofs and try exactly once more.
 */
export const retryOnBeefDepth = async <T>(
  fn: () => Promise<T>,
  sync: (() => Promise<unknown>) | undefined,
  log?: (l: string) => void,
): Promise<T> => {
  let first: T;
  try {
    first = await fn();
  } catch (e) {
    if (!sync || !isBeefDepth(errText(e))) throw e;
    log?.('BEEF depth limit hit; fetching merkle proofs and retrying once');
    await sync();
    return fn();
  }
  const err = (first as { error?: unknown } | null)?.error;
  if (!sync || err == null || !isBeefDepth(String(err))) return first;
  log?.('BEEF depth limit hit; fetching merkle proofs and retrying once');
  await sync();
  return fn();
};

export const beefDepthHelp = (msg: string) =>
  isBeefDepth(msg)
    ? `${msg} The coins descend from a chain of transactions the wallet has no proofs for yet. ` +
      'Run `bwalletx sync -a <account>` once they are mined (next block, ~10 min) and try again.'
    : msg;
