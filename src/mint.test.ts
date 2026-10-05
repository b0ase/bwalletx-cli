import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkItem,
  chunks,
  contentTypeFor,
  estimateSats,
  plan,
  progressPathFor,
  readManifest,
  readProgress,
  sha256,
  titleFromFilename,
  UPLOAD_CHUNK_BYTES,
  writeProgress,
  type Progress,
} from './mint';

const dir = () => mkdtempSync(join(tmpdir(), 'bwx-mint-'));

describe('mint helpers', () => {
  test('content types and titles', () => {
    expect(contentTypeFor('Echoes in the Abyss.mp3')).toBe('audio/mpeg');
    expect(contentTypeFor('a.PNG')).toBe('image/png');
    expect(contentTypeFor('virus.exe')).toBeNull();
    expect(titleFromFilename('/x/Shadows of the Past (Remix).mp3')).toBe('Shadows of the Past (Remix)');
  });

  test('cost estimate matches the app formula (and PLAN.md: 11,689,177 sats for the 35 VexVoid tracks)', () => {
    expect(estimateSats(1000, 100)).toEqual({ network: 191, fee: 2, total: 193 });
    expect(estimateSats(1000, 100, true).network).toBe(382);
    const m = '/Volumes/2026/Projects/bwalletx-site/media-src/vexvoid-mint/manifest.json';
    if (existsSync(m)) {
      const list = JSON.parse(readFileSync(m, 'utf8')) as { bytes: number }[];
      // PLAN.md applies the 1% to the batch total; per tx it rounds up, so allow a few sats per item.
      const total = list.reduce((t, e, i) => t + estimateSats(e.bytes, 100, i === 0).total, 0);
      expect(Math.abs(total - 11_689_177)).toBeLessThan(list.length * 2);
    }
  });

  test('chunks are relay-sized and concatenate into the whole base64', () => {
    const buf = Buffer.alloc(UPLOAD_CHUNK_BYTES * 3 + 7, 9);
    const c = chunks(buf);
    expect(c.length).toBe(4);
    expect(c.join('')).toBe(buf.toString('base64'));
    expect(c.slice(0, -1).every((x) => !x.includes('='))).toBe(true);
    // A sealed frame is base64(AES(JSON with this chunk)): ~4/3 × the chunk + JSON. Must stay under 4 MB.
    expect(Math.ceil((c[0].length + 300) / 3) * 4).toBeLessThan(4 * 1024 * 1024);
  });

  test('checkItem refuses wrong hashes, big files and odd types', () => {
    const d = dir();
    const f = join(d, 'a.mp3');
    writeFileSync(f, 'hello');
    expect(checkItem({ file: f, title: 'A' }).sha).toBe(sha256(Buffer.from('hello')));
    expect(() => checkItem({ file: f, title: 'A', sha256: '0'.repeat(64) })).toThrow(/sha256/);
    writeFileSync(join(d, 'b.exe'), 'x');
    expect(() => checkItem({ file: join(d, 'b.exe'), title: 'B' })).toThrow(/unsupported/);
    writeFileSync(join(d, 'big.mp3'), Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(() => checkItem({ file: join(d, 'big.mp3'), title: 'C' })).toThrow(/10 MB/);
  });
});

describe('resume', () => {
  const items = ['One', 'Two', 'Three'].map((t) => ({ file: `${t}.mp3`, title: t, bytes: 10, contentType: 'audio/mpeg', sha: 'x' }));

  test('first item creates the collection, the rest join it; minted titles are skipped', () => {
    const fresh: Progress = { format: 'bwalletx.mint-progress/1', minted: {} };
    const p1 = plan(items, { kind: 'new', name: 'VexVoid Discography' }, fresh);
    expect(p1.map((s) => s.collection.kind)).toEqual(['new', 'existing', 'existing']);
    const half: Progress = { ...fresh, collectionId: `${'a'.repeat(64)}_0`, minted: { One: { txid: 't', outpoint: 't_0', sats: 1, usd: 0, at: 1 } } };
    const p2 = plan(items, { kind: 'new', name: 'VexVoid Discography' }, half);
    expect(p2.map((s) => s.item.title)).toEqual(['Two', 'Three']);
    expect(p2.every((s) => s.collection.kind === 'existing' && s.collection.id === half.collectionId)).toBe(true);
  });

  test('progress file sits next to the manifest and round-trips', () => {
    const d = dir();
    const m = join(d, 'manifest.json');
    writeFileSync(m, JSON.stringify([{ title: 'One', file: 'One.mp3', sha256: 'ab' }]));
    expect(progressPathFor(m)).toBe(join(d, 'manifest.progress.json'));
    expect(readManifest(m)).toEqual([{ title: 'One', file: join(d, 'One.mp3'), sha256: 'ab' }]);
    const p = progressPathFor(m);
    expect(readProgress(p).minted).toEqual({});
    writeProgress(p, { format: 'bwalletx.mint-progress/1', collectionId: 'c_0', minted: { One: { txid: 't', outpoint: 't_0', sats: 5, usd: 0.01, at: 1 } } });
    expect(readProgress(p).minted.One.txid).toBe('t');
  });
});
