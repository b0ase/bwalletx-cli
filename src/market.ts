/** Read-only market data: BSV price (WhatsOnChain), BSV-21 listings and balances (GorillaPool, 1Sat). */
export const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
export const GP = 'https://ordinals.gorillapool.io/api';
export const ONESAT = 'https://api.1sat.app/1sat';

const UA = { 'user-agent': 'bwalletx-cli/0.1' };
export async function getJson<T>(url: string, timeoutMs = 15_000, init?: RequestInit): Promise<T> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { ...init, headers: { ...UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
    // WhatsOnChain's free tier allows ~3 requests/s: back off on 429 (GETs only).
    if (res.status !== 429 || attempt >= 3 || (init?.method && init.method !== 'GET')) break;
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json() as Promise<T>;
}

let priceCache: { usd: number; at: number } | null = null;
/** USD per BSV (cached 60 s). */
export async function bsvUsd(): Promise<number> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.usd;
  const r = await getJson<{ rate: number }>(`${WOC}/exchangerate`);
  if (!(r.rate > 0)) throw new Error('No BSV price');
  priceCache = { usd: r.rate, at: Date.now() };
  return r.rate;
}

export const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/;
export const normTokenId = (s: string) => s.trim().toLowerCase().replace('.', '_');

export type Listing = { outpoint: string; priceSats: number; amount: string; tokens: number; seller: string | null; pricePerTokenSats: number };
type GpListing = { outpoint: string; amt: string; price: string; pricePer?: string; owner?: string; spend?: string; id: string; sym?: string; dec?: number };

export type TokenInfo = { id: string; sym: string | null; dec: number };
export async function tokenInfo(id: string): Promise<TokenInfo> {
  const o = await getJson<{ id?: string; sym?: string; dec?: number }>(`${GP}/bsv20/id/${encodeURIComponent(id)}`).catch(() => null);
  return { id, sym: o?.sym ?? null, dec: Number(o?.dec ?? 0) };
}

/** Live listings of a BSV-21 token, cheapest per token first. */
export async function listings(id: string, limit = 100): Promise<{ info: TokenInfo; listings: Listing[] }> {
  const rows = await getJson<GpListing[] | null>(`${GP}/bsv20/market?id=${encodeURIComponent(id)}&limit=${limit}&dir=asc&sort=price_per_token`);
  const live = (rows ?? []).filter((r) => !r.spend && r.id === id && Number(r.price) > 0);
  const info: TokenInfo = live[0] ? { id, sym: live[0].sym ?? null, dec: Number(live[0].dec ?? 0) } : await tokenInfo(id);
  const out = live.map((r) => {
    const tokens = Number(r.amt) / 10 ** info.dec;
    const priceSats = Number(r.price);
    return { outpoint: r.outpoint, priceSats, amount: r.amt, tokens, seller: r.owner ?? null, pricePerTokenSats: tokens > 0 ? priceSats / tokens : Infinity };
  });
  out.sort((a, b) => a.pricePerTokenSats - b.pricePerTokenSats);
  return { info, listings: out };
}

export type Price = { id: string; sym: string | null; floorSatsPerToken: number | null; floorUsdPerToken: number | null; bsvUsd: number; listings: number };
export async function tokenPrice(id: string): Promise<Price> {
  const [usd, m] = await Promise.all([bsvUsd(), listings(id)]);
  const floor = m.listings[0]?.pricePerTokenSats ?? null;
  return { id, sym: m.info.sym, floorSatsPerToken: floor, floorUsdPerToken: floor !== null ? (floor / 1e8) * usd : null, bsvUsd: usd, listings: m.listings.length };
}

/** Cheapest whole listing whose price fits the budget. Pure. */
export const pickListing = (ls: Listing[], maxUsd: number, bsvUsdRate: number): Listing | null =>
  ls.filter((l) => (l.priceSats / 1e8) * bsvUsdRate <= maxUsd + 1e-9).sort((a, b) => a.pricePerTokenSats - b.pricePerTokenSats)[0] ?? null;

export async function bsvBalanceSats(address: string): Promise<number> {
  const b = await getJson<{ confirmed: number; unconfirmed: number }>(`${WOC}/address/${address}/balance`);
  return (b.confirmed ?? 0) + (b.unconfirmed ?? 0);
}

export type TokenBalance = { id: string; sym: string | null; dec: number; amount: number };
type GpBal = { id?: string; tick?: string; sym?: string; dec?: number; all?: { confirmed?: string; pending?: string } };
export async function tokenBalances(ordAddress: string): Promise<TokenBalance[]> {
  const rows = await getJson<GpBal[] | null>(`${GP}/bsv20/${ordAddress}/balance`).catch(() => null);
  return (rows ?? [])
    .filter((r) => r.id)
    .map((r) => {
      const dec = Number(r.dec ?? 0);
      const raw = Number(r.all?.confirmed ?? 0) + Number(r.all?.pending ?? 0);
      return { id: r.id!, sym: r.sym ?? null, dec, amount: raw / 10 ** dec };
    })
    .filter((r) => r.amount > 0);
}
