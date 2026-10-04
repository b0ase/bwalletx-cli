import { afterEach, describe, expect, test, vi } from 'vitest';
import { P2PKH, PrivateKey, Spend, Transaction } from '@bsv/sdk';
import { buildSend, resolveDestination } from './wallet';

afterEach(() => vi.unstubAllGlobals());

describe('live BSV send (offline, mocked indexer)', () => {
  test('selects coins, pays the destination, returns change, signs valid inputs', async () => {
    const key = PrivateKey.fromRandom(); // throwaway
    const addr = key.toAddress();
    // A fake parent paying 100k sats and a 1-sat (ordinal) output to our address.
    const parent = new Transaction();
    parent.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 100_000 });
    parent.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 1 });
    const pid = parent.id('hex');
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/unspent'))
        return new Response(JSON.stringify([{ tx_hash: pid, tx_pos: 0, value: 100_000, height: 1 }, { tx_hash: pid, tx_pos: 1, value: 1, height: 1 }]));
      if (url.endsWith(`/tx/${pid}/hex`)) return new Response(parent.toHex());
      return new Response('nope', { status: 404 });
    });
    const to = PrivateKey.fromRandom().toAddress();
    const dest = await resolveDestination(to, 30_000, 'me');
    const tx = await buildSend(key.toWif(), dest, 100);
    expect(tx.inputs).toHaveLength(1); // the 1-sat ordinal is never spent
    expect(tx.outputs[0].satoshis).toBe(30_000);
    const fee = 100_000 - tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0);
    expect(fee).toBeGreaterThan(0);
    expect(fee).toBeLessThan(100);
    const inp = tx.inputs[0];
    const spend = new Spend({
      sourceTXID: pid, sourceOutputIndex: 0, sourceSatoshis: 100_000, lockingScript: parent.outputs[0].lockingScript,
      transactionVersion: tx.version, otherInputs: [], outputs: tx.outputs, inputIndex: 0,
      unlockingScript: inp.unlockingScript!, inputSequence: inp.sequence ?? 0xffffffff, lockTime: tx.lockTime,
    });
    expect(spend.validate()).toBe(true);
  });

  test('not enough money is an error, nothing built', async () => {
    vi.stubGlobal('fetch', async () => new Response('[]'));
    await expect(buildSend(PrivateKey.fromRandom().toWif(), { outputs: [{ script: '76a914' + '00'.repeat(20) + '88ac', satoshis: 10 }] })).rejects.toThrow('Not enough BSV');
  });
});
