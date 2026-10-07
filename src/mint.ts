/**
 * `bwalletx mint` / `bwalletx mint-manifest`: mint media from a paired phone (scope "Mint NFTs").
 *
 * Keys never leave the phone. Files go over the encrypted pairing channel in 1.5 MiB chunks
 * (`mint_upload`; the relay caps frames at 4 MB and a sealed frame is ~1.8× the raw bytes), then
 * `mint` asks the phone to build, sign and broadcast exactly what the Mint screen would, within the
 * item and dollar limits approved at pairing. The phone checks the budget before it signs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { bsvUsd } from './market.js';
import { PhoneSession, type MintInfo } from './paired.js';
import { appendLog, readConfig, resolveAccount } from './store.js';

/** Same numbers as the app (src/mobile/mint/mint.ts, src/mobile/pair/mintScope.ts). */
export const MAX_MINT_BYTES = 10 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1_572_864;
export const TX_OVERHEAD_BYTES = 900;
export const MINT_FEE_RATE = 0.01;
const MINT_TIMEOUT_MS = 180_000;

const TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
};
export const contentTypeFor = (file: string): string | null => TYPES[extname(file).toLowerCase()] ?? null;
export const titleFromFilename = (file: string) => basename(file, extname(file)).trim().slice(0, 100);

/** App formula: ceil((bytes + 900) × sat/kB / 1000) + 1 per tx; ×2 when the mint creates the collection; +1% fee. */
export function estimateSats(bytes: number, satsPerKb: number, newCollection = false, withFee = true) {
  const network = (Math.ceil(((bytes + TX_OVERHEAD_BYTES) * satsPerKb) / 1000) + 1) * (newCollection ? 2 : 1);
  const fee = withFee && network > 0 ? Math.max(1, Math.ceil(network * MINT_FEE_RATE)) : 0;
  return { network, fee, total: network + fee };
}

/** Base64 chunks of whole 1.5 MiB pieces (a multiple of 3 bytes, so they concatenate into one base64). */
export function chunks(buf: Buffer, size = UPLOAD_CHUNK_BYTES): string[] {
  if (size % 3) throw new Error('chunk size must be a multiple of 3');
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size).toString('base64'));
  return out;
}

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

export type Item = { file: string; title: string; sha256?: string };
export type Checked = Item & { bytes: number; contentType: string; sha: string };

/** Local checks before anything is sent: exists, size, type, hash (when the manifest has one). */
export function checkItem(it: Item): Checked {
  if (!existsSync(it.file)) throw new Error(`Missing file: ${it.file}`);
  const bytes = statSync(it.file).size;
  if (bytes <= 0) throw new Error(`Empty file: ${it.file}`);
  if (bytes > MAX_MINT_BYTES) throw new Error(`${basename(it.file)} is ${(bytes / 1048576).toFixed(1)} MB; the mint limit is 10 MB`);
  const contentType = contentTypeFor(it.file);
  if (!contentType) throw new Error(`Can't mint ${basename(it.file)}: unsupported file type`);
  if (!it.title.trim()) throw new Error(`No title for ${it.file}`);
  if (it.title.trim().length > 100) throw new Error(`Title over 100 characters: ${it.title}`);
  const sha = sha256(readFileSync(it.file));
  if (it.sha256 && it.sha256.toLowerCase() !== sha) throw new Error(`${basename(it.file)} doesn't match the manifest sha256`);
  return { ...it, bytes, contentType, sha };
}

// ---- progress file (resume-safe reruns) ----

export type Done = { txid: string; outpoint: string; sats: number; usd: number; at: number };
export type Progress = { format: 'bwalletx.mint-progress/1'; collection?: string; collectionId?: string; minted: Record<string, Done> };

export const progressPathFor = (manifest: string) => join(dirname(resolve(manifest)), `${basename(manifest, extname(manifest))}.progress.json`);
export function readProgress(path: string): Progress {
  if (!existsSync(path)) return { format: 'bwalletx.mint-progress/1', minted: {} };
  const p = JSON.parse(readFileSync(path, 'utf8')) as Progress;
  if (p.format !== 'bwalletx.mint-progress/1' || typeof p.minted !== 'object') throw new Error(`Not a progress file: ${path}`);
  return p;
}
export function writeProgress(path: string, p: Progress) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, path); // atomic: a crash never leaves half a file
}

export type CollectionChoice = { kind: 'none' } | { kind: 'new'; name: string } | { kind: 'existing'; id: string };

/**
 * What to mint next, given what's done: skips minted titles; the first item creates the collection
 * unless the progress file already has its id.
 */
export function plan(items: Checked[], collection: CollectionChoice, progress: Progress) {
  const todo = items.filter((i) => !progress.minted[i.title.trim()]);
  const coll = (first: boolean): CollectionChoice =>
    collection.kind === 'new' && progress.collectionId
      ? { kind: 'existing', id: progress.collectionId }
      : collection.kind === 'new' && !first
        ? { kind: 'existing', id: '' } // filled in from the first mint's collectionId
        : collection;
  return todo.map((it, i) => ({ item: it, collection: coll(i === 0) }));
}

// ---- running ----

export type MintResult = { txid: string; outpoint: string; origin: string; collectionId?: string; sats: number; usd: number; mint: Omit<MintInfo, 'maxItems' | 'maxUsd'> };
type Out = (s: string) => void;
const usd = (n: number) => `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;

async function upload(s: PhoneSession, it: Checked, out: Out): Promise<string> {
  const parts = chunks(readFileSync(it.file));
  const uploadId = `up-${it.sha.slice(0, 12)}-${Date.now().toString(36)}`;
  for (let i = 0; i < parts.length; i++) {
    await s.call('mint_upload', { uploadId, index: i, total: parts.length, bytes: it.bytes, sha256: it.sha, data: parts[i] });
    if (parts.length > 1) out(`    sent ${i + 1}/${parts.length}`);
  }
  return uploadId;
}

export type RunOpts = {
  account?: string;
  collection: CollectionChoice;
  description?: string;
  dryRun?: boolean;
  progressPath?: string;
  out?: Out;
};

export type Summary = { minted: (Done & { title: string })[]; skipped: string[]; totalSats: number; totalUsd: number; collectionId?: string; dryRun: boolean; estimate?: { sats: number; usd: number | null; satsPerKb: number } };

/** Mint items in order. Stops at the first error (rerun to resume when a progress file is used). */
export async function runMint(items: Item[], o: RunOpts): Promise<Summary> {
  const out = o.out ?? console.log;
  const checked = items.map(checkItem);
  const titles = new Set<string>();
  for (const c of checked) {
    if (titles.has(c.title.trim())) throw new Error(`Duplicate title: ${c.title}`);
    titles.add(c.title.trim());
  }
  const progress: Progress = o.progressPath ? readProgress(o.progressPath) : { format: 'bwalletx.mint-progress/1', minted: {} };
  if (o.collection.kind === 'new') {
    if (progress.collection && progress.collection !== o.collection.name)
      throw new Error(`The progress file is for collection "${progress.collection}", not "${o.collection.name}"`);
    progress.collection = o.collection.name;
  }
  const steps = plan(checked, o.collection, progress);
  const skipped = checked.filter((c) => progress.minted[c.title.trim()]).map((c) => c.title);
  const summary: Summary = { minted: [], skipped, totalSats: 0, totalUsd: 0, collectionId: progress.collectionId, dryRun: !!o.dryRun };
  if (skipped.length) out(`Skipping ${skipped.length} already minted (${o.progressPath}).`);

  const estimateFor = (satsPerKb: number) =>
    steps.reduce((t, st, i) => t + estimateSats(st.item.bytes, satsPerKb, i === 0 && st.collection.kind === 'new').total, 0);

  if (o.dryRun) {
    const satsPerKb = readConfig().satsPerKb ?? 100;
    const rate = await bsvUsd().catch(() => 0);
    for (const [i, st] of steps.entries()) {
      const e = estimateSats(st.item.bytes, satsPerKb, i === 0 && st.collection.kind === 'new');
      out(`  ${String(i + 1).padStart(3)}. ${st.item.title.padEnd(40)} ${(st.item.bytes / 1048576).toFixed(2).padStart(6)} MB  ${String(e.total).padStart(9)} sats${rate ? `  ${usd((e.total / 1e8) * rate)}` : ''}`);
    }
    const sats = estimateFor(satsPerKb);
    summary.estimate = { sats, usd: rate ? (sats / 1e8) * rate : null, satsPerKb };
    return summary;
  }

  if (!steps.length) return summary;
  const account = resolveAccount(o.account);
  if (account.kind !== 'paired') throw new Error(`Minting runs on the phone: "${account.name}" must be a paired account (bwalletx login).`);
  const s = await PhoneSession.open(account.name);
  try {
    const info = await s.call<{ scopes: string[]; mint: MintInfo | null }>('info');
    if (!info.scopes.includes('mint') || !info.mint)
      throw new Error('This pairing may not mint. Run `bwalletx login --account ' + account.name + '` again and turn on "Mint NFTs" on the phone.');
    const q = await s.call<{ satsPerKb: number; bsvUsd: number }>('mint_quote', { bytes: 1 });
    const est = estimateFor(q.satsPerKb);
    const estUsd = q.bsvUsd ? (est / 1e8) * q.bsvUsd : null;
    out(`${steps.length} to mint at ${q.satsPerKb} sat/kB: about ${est.toLocaleString()} sats${estUsd !== null ? ` (${usd(estUsd)})` : ''}.`);
    out(`Phone allows ${info.mint.itemsLeft} more items and ${usd(info.mint.usdLeft)} more.`);
    if (info.mint.itemsLeft < steps.length) out(`Warning: only ${info.mint.itemsLeft} items left in the pairing; the phone will refuse the rest.`);
    if (estUsd !== null && estUsd > info.mint.usdLeft) out(`Warning: the estimate is over the ${usd(info.mint.usdLeft)} left; the phone will refuse once the budget runs out.`);

    for (const [i, st] of steps.entries()) {
      const it = st.item;
      let collection = st.collection;
      if (collection.kind === 'existing' && !collection.id) {
        if (!progress.collectionId) throw new Error('The collection was not created');
        collection = { kind: 'existing', id: progress.collectionId };
      }
      out(`[${i + 1}/${steps.length}] ${it.title} (${(it.bytes / 1048576).toFixed(2)} MB${collection.kind === 'new' ? `, new collection "${collection.name}"` : ''})`);
      const big = it.bytes > UPLOAD_CHUNK_BYTES;
      const content = big
        ? { uploadId: await upload(s, it, out), bytes: it.bytes }
        : { base64Content: readFileSync(it.file).toString('base64') };
      const r = await s.call<MintResult>(
        'mint',
        { ...content, contentType: it.contentType, name: it.title.trim(), description: o.description ?? '', collection },
        MINT_TIMEOUT_MS,
      );
      if (r.collectionId && collection.kind === 'new') progress.collectionId = summary.collectionId = r.collectionId;
      const done: Done = { txid: r.txid, outpoint: r.outpoint, sats: r.sats, usd: r.usd, at: Date.now() };
      progress.minted[it.title.trim()] = done;
      if (o.progressPath) writeProgress(o.progressPath, progress);
      appendLog(account.name, { at: done.at, action: 'mint', detail: `Minted "${it.title}"`, usd: r.usd, txid: r.txid });
      summary.minted.push({ title: it.title, ...done });
      summary.totalSats += r.sats;
      summary.totalUsd += r.usd;
      out(`    ${r.outpoint}  ${r.sats.toLocaleString()} sats ${usd(r.usd)}  (left: ${r.mint.itemsLeft} items, ${usd(r.mint.usdLeft)})`);
    }
  } finally {
    s.close();
  }
  return summary;
}

/** A manifest is the array written by the VexVoid prep script: [{ title, file, bytes?, sha256? }]. */
export function readManifest(path: string): Item[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
  if (!Array.isArray(list) || !list.length) throw new Error(`${path}: expected a non-empty array of { title, file }`);
  const dir = dirname(resolve(path));
  return list.map((e, i) => {
    const x = e as { title?: unknown; file?: unknown; sha256?: unknown };
    if (typeof x.title !== 'string' || typeof x.file !== 'string') throw new Error(`${path}: entry ${i + 1} needs title and file`);
    return { title: x.title, file: resolve(dir, x.file), ...(typeof x.sha256 === 'string' && { sha256: x.sha256 }) };
  });
}

/** --collection / --collection-id → a CollectionChoice (shared by the CLI and MCP). */
export const collectionOf = (o: { collection?: string; collectionId?: string }): CollectionChoice => {
  if (o.collection && o.collectionId) throw new Error('Use --collection (new) or --collection-id (existing), not both');
  if (o.collectionId) {
    if (!/^[0-9a-f]{64}_\d+$/.test(o.collectionId)) throw new Error('--collection-id must be <txid>_<vout>');
    return { kind: 'existing', id: o.collectionId };
  }
  return o.collection ? { kind: 'new', name: o.collection } : { kind: 'none' };
};

/** Files + --title / --title-from-filename → mint items (shared by the CLI and MCP). */
export function itemsFor(files: string[], o: { title?: string; titleFromFilename?: boolean }): Item[] {
  if (o.title && files.length > 1) throw new Error('--title is for one file; use --title-from-filename for several');
  if (!o.title && !o.titleFromFilename) throw new Error('Give --title, or --title-from-filename');
  return files.map((f) => ({ file: f, title: o.title ?? titleFromFilename(f) }));
}
