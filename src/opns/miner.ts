/**
 * Multi-core OpNS proof of work for the CLI: one worker thread per core (default: cores − 1), each searching
 * its own random nonce prefix; the first solution wins and the rest are terminated.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { OPNS_DIFFICULTY } from './opnsPow.js';
import { randomPrefix } from './opnsMint.js';
import { MiningCancelled, type MineChar } from './opnsRegister.js';

export const defaultThreads = () => Math.max(1, availableParallelism() - 1);
let threads = defaultThreads();
export const setThreads = (n: number) => {
  threads = Math.max(1, Math.floor(n));
};
export const getThreads = () => threads;

const WORKER_URL = new URL('./minerWorker.js', import.meta.url);

export const threadMine = (
  pow: number[],
  char: number,
  signal: AbortSignal,
  onProgress: (tried: number, rate: number) => void,
  o: { threads?: number; difficulty?: number } = {},
): Promise<{ nonce: number[]; hash: number[] }> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new MiningCancelled());
    const n = o.threads ?? threads;
    const t0 = performance.now();
    let tried = 0;
    let done = false;
    const workers: Worker[] = [];
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', stop);
      for (const w of workers) void w.terminate();
      fn();
    };
    const stop = () => finish(() => reject(new MiningCancelled()));
    signal.addEventListener('abort', stop, { once: true });
    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_URL, {
        workerData: { pow, char, prefix: randomPrefix(), difficulty: o.difficulty ?? OPNS_DIFFICULTY },
      });
      workers.push(w);
      w.on('message', (m: { type: string; tried?: number; nonce?: number[]; hash?: number[] }) => {
        if (m.type === 'progress') {
          tried += m.tried ?? 0;
          const secs = (performance.now() - t0) / 1000;
          onProgress(tried, secs > 0 ? tried / secs : 0);
        } else if (m.type === 'found') finish(() => resolve({ nonce: m.nonce!, hash: m.hash! }));
        else if (m.type === 'exhausted') finish(() => reject(new Error('Nonce space exhausted; try again')));
      });
      w.on('error', (e: Error) => finish(() => reject(new Error(e.message || 'Miner crashed'))));
    }
  });

export const threadMineChar: MineChar = (pow, char, signal, onProgress) => threadMine(pow, char, signal, onProgress);

/** Hash rate over `seconds` with `n` threads (no solution needed: difficulty set out of reach). */
export const benchmark = async (seconds = 8, n = threads): Promise<{ threads: number; rate: number }> => {
  const ctl = new AbortController();
  let rate = 0;
  const timer = setTimeout(() => ctl.abort(), seconds * 1000);
  await threadMine(new Array(32).fill(7), 97, ctl.signal, (_t, r) => (rate = r), { threads: n, difficulty: 64 }).catch(
    () => undefined,
  );
  clearTimeout(timer);
  return { threads: n, rate };
};
