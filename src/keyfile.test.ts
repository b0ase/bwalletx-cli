import { describe, expect, test } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { decryptKeyFile, encryptKeyFile, KEYFILE_FORMAT, validateKeyFile } from './keyfile';

// Fresh throwaway keys, generated per run.
const keys = () => ({ payPk: PrivateKey.fromRandom().toWif(), ordPk: PrivateKey.fromRandom().toWif(), identityPk: PrivateKey.fromRandom().toWif() });

describe('key file', () => {
  test('round-trips with the full 310k iterations', async () => {
    const k = keys();
    const id = PrivateKey.fromWif(k.identityPk).toAddress();
    const f = await encryptKeyFile('trader', id, k, 'correct horse');
    expect(f).toMatchObject({ format: KEYFILE_FORMAT, name: 'trader', identityAddress: id, enc: { kdf: 'pbkdf2-sha256', iter: 310000, alg: 'aes-256-gcm' } });
    expect(Buffer.from(f.enc.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(f.enc.iv, 'base64')).toHaveLength(12);
    expect(JSON.stringify(f)).not.toContain(k.payPk);
    const back = await decryptKeyFile(JSON.parse(JSON.stringify(f)), 'correct horse');
    expect(back).toEqual(k);
  });

  test('wrong passphrase and tampering are refused', async () => {
    const f = await encryptKeyFile('t', '1x', keys(), 'pw', 100_000);
    await expect(decryptKeyFile(f, 'nope')).rejects.toThrow('Wrong passphrase');
    const data = Buffer.from(f.enc.data, 'base64');
    data[0] ^= 1;
    await expect(decryptKeyFile({ ...f, enc: { ...f.enc, data: data.toString('base64') } }, 'pw')).rejects.toThrow('Wrong passphrase');
  });

  test('matches node:crypto AES-256-GCM with the tag appended (WebCrypto layout)', async () => {
    const { pbkdf2Sync, createDecipheriv } = await import('node:crypto');
    const k = keys();
    const f = await encryptKeyFile('t', '1x', k, 'pw', 100_000);
    const key = pbkdf2Sync('pw', Buffer.from(f.enc.salt, 'base64'), f.enc.iter, 32, 'sha256');
    const all = Buffer.from(f.enc.data, 'base64');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.enc.iv, 'base64'));
    d.setAuthTag(all.subarray(all.length - 16));
    const plain = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
    expect(JSON.parse(plain)).toEqual(k);
  });

  test('shape checks', () => {
    expect(() => validateKeyFile({ format: 'x' })).toThrow();
    expect(() => validateKeyFile({ format: KEYFILE_FORMAT, name: '../evil', identityAddress: '1', enc: {} })).toThrow('name');
  });
});
