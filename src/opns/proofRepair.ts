/**
 * Stale merkle proofs after a reorg (16 Oct 2026, run stopped at 2965/31294 with "merged Beef failed validation").
 *
 * Block 971225 had two competing versions. The wallet's proof task fetched proofs for 86 of our mint txs from
 * the losing block (00…0f08c6cb, merkle root 35bc5d…) and marked them completed; the chain kept 00…19b7ff (root
 * ccad32…), which holds the same txs. The CLI's monitor gets no reorg events, so those proofs were never redone.
 * Every later mint spends change that descends from those txs; the wallet builds its BEEF with the stale BUMP,
 * the chain tracker rejects root 35bc5d… for height 971225, and createAction throws WERR_INTERNAL "merged Beef
 * failed validation." — for every name, so the run stopped after ten in a row.
 *
 * Repair: check each distinct (height, merkleRoot) the wallet holds against the chain tracker and re-prove the
 * transactions under any root the chain does not know (toolbox reproveHeightMerkleRoot fetches the canonical
 * proof, updates proven_txs and drops prepared BEEFs). Nothing is broadcast or spent.
 */

export type ProofRoot = { height: number; merkleRoot: string };

export type RepairDeps = {
  /** Distinct proof roots the wallet holds, newest heights first. */
  roots: () => Promise<ProofRoot[]>;
  isValidRoot: (merkleRoot: string, height: number) => Promise<boolean>;
  /** Re-prove every tx stored under this stale root; counts of proofs replaced / still without a replacement. */
  reprove: (height: number, merkleRoot: string) => Promise<{ updated: number; unavailable: number }>;
};

export type RepairResult = { checked: number; stale: ProofRoot[]; updated: number; unavailable: number; errors: number };

export const emptyRepair = (): RepairResult => ({ checked: 0, stale: [], updated: 0, unavailable: 0, errors: 0 });

/** Check at most `max` roots (newest first): reorgs are shallow, and this runs before every batch. */
export const repairStaleProofs = async (d: RepairDeps, max = 500): Promise<RepairResult> => {
  const r = emptyRepair();
  const roots = (await d.roots()).slice(0, max);
  for (const root of roots) {
    let ok: boolean;
    try {
      ok = await d.isValidRoot(root.merkleRoot, root.height);
    } catch {
      r.errors++; // chain tracker unreachable: can't judge this root, leave it alone
      continue;
    }
    r.checked++;
    if (ok) continue;
    r.stale.push(root);
    try {
      const x = await d.reprove(root.height, root.merkleRoot);
      r.updated += x.updated;
      r.unavailable += x.unavailable;
    } catch {
      r.errors++;
    }
  }
  return r;
};

/** The wallet refused its own BEEF (toolbox processAction: "merged Beef failed validation."). */
export const isBadBeef = (msg: string) => /merged Beef failed validation|VERIFY FALSE BEEF/i.test(msg);

export const describeRepair = (r: RepairResult) =>
  r.stale.length
    ? `proof check: ${r.stale.length} stale block root(s) (${r.stale.map((s) => `height ${s.height}`).join(', ')}); ${r.updated} proof(s) replaced, ${r.unavailable} without a replacement yet`
    : `proof check: ${r.checked} block root(s) OK${r.errors ? `, ${r.errors} not checked (chain tracker unreachable)` : ''}`;

/** What the owner sees when the wallet still refuses its BEEF after a repair attempt. */
export const badBeefHelp = (msg: string, r: RepairResult | null) =>
  `${msg} The wallet's coins descend from a transaction whose merkle proof points at a block the chain no longer has (a reorg).` +
  (r ? ` ${describeRepair(r)}.` : '') +
  ' Nothing was broadcast. Run the same command again in about 30 minutes: each run re-checks the proofs and replaces stale ones before mining.';
