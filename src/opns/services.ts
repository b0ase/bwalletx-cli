/** The indexer endpoints the OpNS code uses (bWalletX src/mobile/names/names.ts SERVICES), and the fetch type. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SERVICES = {
  opnsOrigin: 'https://api.1sat.app/1sat/opns/origin',
  opnsMine: 'https://api.1sat.app/1sat/opns/mine',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with backoff on 429 / 5xx / network errors (copied from bWalletX opnsBatch.ts withBackoff). */
export const withBackoff =
  (f: Fetch, tries = 4, baseMs = 300): Fetch =>
  async (url, init) => {
    for (let a = 0; ; a++) {
      try {
        const res = await f(url, init);
        if ((res.status === 429 || res.status >= 500) && a < tries - 1) {
          await sleep(baseMs * 2 ** a);
          continue;
        }
        return res;
      } catch (e) {
        if (a >= tries - 1) throw e;
        await sleep(baseMs * 2 ** a);
      }
    }
  };

/** At most `perSecond` requests start per second (the indexer rate-limits bursts). */
export const throttled = (f: Fetch, perSecond = 8): Fetch => {
  const gap = 1000 / perSecond;
  let next = 0;
  return async (url, init) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
    return f(url, init);
  };
};

/** The CLI's indexer fetch: throttled, with backoff, 20 s timeout per request. */
export const indexerFetch = (perSecond = 8): Fetch =>
  withBackoff(throttled((url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }), perSecond));
