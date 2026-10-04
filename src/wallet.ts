/**
 * Live signing for standalone mode: plain P2PKH BSV sends with @bsv/sdk against WhatsOnChain UTXOs,
 * broadcast to ARC (GorillaPool) with WhatsOnChain as fallback. Paymail via bsvalias (P2P destinations,
 * then basic paymentDestination). Keys only ever live in memory, decrypted from the key file.
 */
import { ARC, P2PKH, PrivateKey, SatoshisPerKilobyte, Script, Transaction } from '@bsv/sdk';
import { getJson, WOC } from './market.js';

export const DEFAULT_SATS_PER_KB = 100;
export const ARC_URL = 'https://arc.gorillapool.io';

type Utxo = { tx_hash: string; tx_pos: number; value: number; height: number };

export async function utxos(address: string): Promise<Utxo[]> {
  const r = await getJson<Utxo[] | { result?: Utxo[] }>(`${WOC}/address/${address}/unspent`);
  return Array.isArray(r) ? r : (r.result ?? []);
}

async function rawTx(txid: string): Promise<string> {
  let res = await fetch(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(15_000) });
  for (let i = 1; res.status === 429 && i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 800 * i));
    res = await fetch(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(15_000) });
  }
  if (!res.ok) throw new Error(`WhatsOnChain tx ${res.status}`);
  return (await res.text()).trim();
}

export type Destination = { outputs: { script: string; satoshis: number }[]; p2p?: { url: string; reference: string } };

/** Turn an address or paymail into locking scripts for `sats`. */
export async function resolveDestination(to: string, sats: number, sender: string): Promise<Destination> {
  if (!to.includes('@')) {
    return { outputs: [{ script: new P2PKH().lock(to).toHex(), satoshis: sats }] };
  }
  const [alias, domain] = to.toLowerCase().split('@');
  if (!alias || !domain) throw new Error(`Bad paymail ${to}`);
  const caps = (await getJson<{ capabilities?: Record<string, unknown> }>(`https://${domain}/.well-known/bsvalias`)).capabilities ?? {};
  const fill = (u: string) => u.replace('{alias}', alias).replace('{domain.tld}', domain);
  const p2pDest = caps['2a40af698840'];
  const p2pRecv = caps['5f1323cddf31'];
  if (typeof p2pDest === 'string' && typeof p2pRecv === 'string') {
    const r = await getJson<{ outputs: { script: string; satoshis: number }[]; reference: string }>(fill(p2pDest), 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ satoshis: sats }),
    });
    if (!r.outputs?.length) throw new Error('Paymail returned no outputs');
    return { outputs: r.outputs, p2p: { url: fill(p2pRecv), reference: r.reference } };
  }
  const basic = caps.paymentDestination;
  if (typeof basic === 'string') {
    const r = await getJson<{ output: string }>(fill(basic), 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ senderHandle: sender, senderName: 'bwalletx-cli', dt: new Date().toISOString(), amount: sats, purpose: 'bwalletx send' }),
    });
    if (!r.output) throw new Error('Paymail returned no output');
    return { outputs: [{ script: r.output, satoshis: sats }] };
  }
  throw new Error(`${domain} doesn't offer a paymail payment destination`);
}

/** Build + sign a tx paying `dest` from the pay key's P2PKH UTXOs, change back to the pay address. */
export async function buildSend(payWif: string, dest: Destination, satsPerKb = DEFAULT_SATS_PER_KB): Promise<Transaction> {
  const key = PrivateKey.fromWif(payWif);
  const address = key.toAddress();
  const need = dest.outputs.reduce((s, o) => s + o.satoshis, 0);
  // Coins of 1 sat may be ordinals/tokens: never spend them as fee money.
  const coins = (await utxos(address)).filter((u) => u.value > 1).sort((a, b) => b.value - a.value);
  const tx = new Transaction();
  let have = 0;
  for (const u of coins) {
    if (have >= need + 200 + tx.inputs.length * 20) break;
    tx.addInput({
      sourceTransaction: Transaction.fromHex(await rawTx(u.tx_hash)),
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
    have += u.value;
  }
  if (have < need) throw new Error(`Not enough BSV: have ${have} sats, need ${need} + fee`);
  for (const o of dest.outputs) tx.addOutput({ lockingScript: Script.fromHex(o.script), satoshis: o.satoshis });
  tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
  await tx.fee(new SatoshisPerKilobyte(satsPerKb));
  await tx.sign();
  return tx;
}

export async function broadcast(tx: Transaction): Promise<string> {
  const txid = tx.id('hex');
  let arcErr = 'unknown';
  try {
    const arc = await tx.broadcast(new ARC(ARC_URL));
    if (arc.status === 'success') return txid;
    arcErr = `${arc.code ?? ''} ${arc.description ?? ''}`.trim();
  } catch (e) {
    arcErr = e instanceof Error ? e.message : String(e);
  }
  const res = await fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txhex: tx.toHex() }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.text()).replace(/"/g, '').trim();
  if (res.ok && /^[0-9a-f]{64}$/.test(body)) return body;
  throw new Error(`Broadcast failed: ARC ${arcErr}; WhatsOnChain ${res.status} ${body.slice(0, 200)}`);
}

/** Hand a P2P paymail payment to the receiver (it broadcasts too). */
export async function notifyP2p(p2p: NonNullable<Destination['p2p']>, tx: Transaction, sender: string) {
  const res = await fetch(p2p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hex: tx.toHex(), reference: p2p.reference, metadata: { sender, note: 'bwalletx' } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Paymail receiver refused the payment (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export const addressOf = (wif: string) => PrivateKey.fromWif(wif).toAddress();
