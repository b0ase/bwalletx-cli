import { describe, expect, it } from 'vitest';
import { Beef, P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction } from '@bsv/sdk';
import { appAddresses, outgoingSats } from './brc100';

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();

describe('outgoingSats', () => {
  it('counts every output when the caller brings no inputs', () => {
    expect(outgoingSats({ description: 'pay two', outputs: [{ lockingScript: lock, satoshis: 1000, outputDescription: 'one' }, { lockingScript: lock, satoshis: 25, outputDescription: 'two' }] })).toBe(1025);
  });

  it("subtracts what the caller's own inputs bring in (a pool paying out on a sell)", () => {
    const src = new Transaction();
    src.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 50_000 });
    const beef = new Beef();
    beef.mergeTransaction(src);
    const outpoint = `${src.id('hex')}.0`;
    const args = {
      description: 'sell to the curve',
      inputBEEF: beef.toBinary(),
      inputs: [{ outpoint, inputDescription: 'pool coin', unlockingScriptLength: 108 }],
      outputs: [{ lockingScript: lock, satoshis: 49_000, outputDescription: 'pool change' }],
    };
    expect(outgoingSats(args)).toBe(0);
    expect(outgoingSats({ ...args, outputs: [{ lockingScript: lock, satoshis: 60_000, outputDescription: 'more out' }] })).toBe(10_000);
  });

  it('counts outputs in full when the BEEF is unreadable', () => {
    expect(outgoingSats({ description: 'bad beef', inputBEEF: [1, 2, 3], inputs: [{ outpoint: `${'a'.repeat(64)}.0`, inputDescription: 'x', unlockingScriptLength: 1 }], outputs: [{ lockingScript: lock, satoshis: 700, outputDescription: 'out' }] })).toBe(700);
  });
});


describe('appAddresses', () => {
  it("matches the bWalletX app's receive address (ProtoWallet getPublicKey forSelf, [0,'onesat'], '1sat 0')", async () => {
    const id = PrivateKey.fromRandom();
    const { publicKey } = await new ProtoWallet(id).getPublicKey({ protocolID: [0, 'onesat'], keyID: '1sat 0', forSelf: true });
    expect(appAddresses(id.toWif(), 1)[0].address).toBe(PublicKey.fromString(publicKey).toAddress());
  });
});
