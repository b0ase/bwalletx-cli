/**
 * OpNS miner thread (node:worker_threads), the CLI twin of bWalletX opnsMiner.worker.ts. One job = one character.
 *   in (workerData): { pow, char, prefix }   (each thread gets its own random 27-byte nonce prefix)
 *   out: { type: 'progress', tried } … then { type: 'found', nonce, hash } or { type: 'exhausted' }
 * The parent stops it by terminating the thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { mineRange } from './opnsPow.js';

const CHUNK = 256 * 256; // ~65k attempts between progress reports

const { pow, char, prefix, difficulty } = workerData as { pow: number[]; char: number; prefix: number[]; difficulty?: number };
let ctr = 0;
for (;;) {
  const r = mineRange(pow, char, prefix, ctr, CHUNK, difficulty);
  if ('nonce' in r) {
    parentPort?.postMessage({ type: 'found', nonce: r.nonce, hash: r.hash });
    break;
  }
  ctr += r.tried / 256;
  parentPort?.postMessage({ type: 'progress', tried: r.tried });
  if (ctr >= 0xffffffff) {
    parentPort?.postMessage({ type: 'exhausted' });
    break;
  }
}
