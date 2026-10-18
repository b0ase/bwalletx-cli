import { describe, expect, test } from 'vitest';
import { badBeefHelp, isBadBeef, repairStaleProofs, type ProofRoot } from './proofRepair.js';

// The real case (wallet storage of the "opns" account, 16 Oct 2026): two proof roots at height 971225, one from
// the block the chain kept (00…19b7ff, root ccad32…), one from the orphan (00…0f08c6cb, root 35bc5d…).
const KEPT = 'ccad32c28e5cf9e103fc20be2edc9bad2a61b9814092b46eacdb9f32871bcbaa';
const ORPHAN = '35bc5dab8837b5b6ea10913cf7cc1cd1db9dc375ea4317b8fab6aa97ebd473d2';
const roots: ProofRoot[] = [
  { height: 971279, merkleRoot: '2b99217d03a8bdf2dd2d838d4463d7a69168c7b5e7944e1d6c4be8e3481d35b8' },
  { height: 971225, merkleRoot: ORPHAN },
  { height: 971225, merkleRoot: KEPT },
];

describe('repairStaleProofs', () => {
  test('re-proves only the roots the chain does not know', async () => {
    const reproved: ProofRoot[] = [];
    const r = await repairStaleProofs({
      roots: async () => roots,
      isValidRoot: async (root) => root !== ORPHAN,
      reprove: async (height, merkleRoot) => (reproved.push({ height, merkleRoot }), { updated: 86, unavailable: 0 }),
    });
    expect(reproved).toEqual([{ height: 971225, merkleRoot: ORPHAN }]);
    expect(r).toMatchObject({ checked: 3, updated: 86, unavailable: 0, errors: 0 });
    expect(r.stale).toHaveLength(1);
  });

  test('an unreachable chain tracker never marks a root stale', async () => {
    let reproves = 0;
    const r = await repairStaleProofs({
      roots: async () => roots,
      isValidRoot: async () => {
        throw new Error('fetch failed');
      },
      reprove: async () => (reproves++, { updated: 1, unavailable: 0 }),
    });
    expect(reproves).toBe(0);
    expect(r).toMatchObject({ checked: 0, errors: 3, updated: 0 });
  });

  test('checks at most `max` roots', async () => {
    let n = 0;
    await repairStaleProofs({ roots: async () => roots, isValidRoot: async () => (n++, true), reprove: async () => ({ updated: 0, unavailable: 0 }) }, 2);
    expect(n).toBe(2);
  });

  test('error recognised, help is actionable', () => {
    expect(isBadBeef('merged Beef failed validation.')).toBe(true);
    expect(isBadBeef('covenant check failed')).toBe(false);
    const msg = badBeefHelp('merged Beef failed validation.', { checked: 96, stale: [{ height: 971225, merkleRoot: ORPHAN }], updated: 0, unavailable: 86, errors: 0 });
    expect(msg).toMatch(/height 971225/);
    expect(msg).toMatch(/Nothing was broadcast/);
    expect(msg).toMatch(/Run the same command again/);
  });
});
