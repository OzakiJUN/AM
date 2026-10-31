// Balances of my model services (docs/design.md §9 余额) and the low-balance
// reminder. Only services with a lookup (providers.ts balanceQuery).
import { create } from 'zustand';
import { toast } from '@/ui';
import { aiGet } from '../transport';
import { balanceQuery, balanceText, parseBalance, type Balance, type Provider } from './providers';

export interface BalanceState {
  /** provider id -> last lookup. */
  byProvider: Record<string, { at: number; balance?: Balance; error?: string }>;
}

export const useBalance = create<BalanceState>(() => ({ byProvider: {} }));

const reminded = new Map<string, number>();

/** Looks the balance up (nothing for services without a lookup); reminds me when it is low. */
export async function checkBalance(p: Provider): Promise<void> {
  const q = balanceQuery(p);
  if (!q || !p.key) return;
  let entry: BalanceState['byProvider'][string];
  try {
    const r = await aiGet(q.url, q.headers);
    const b = parseBalance(p, r.status, r.body);
    entry = 'error' in b ? { at: Date.now(), error: b.error } : { at: Date.now(), balance: b };
  } catch (e) {
    entry = { at: Date.now(), error: e instanceof Error ? e.message : String(e) };
  }
  useBalance.setState((st) => ({ byProvider: { ...st.byProvider, [p.id]: entry } }));
  const low = p.lowBalance ?? 0;
  // At most once every 6 hours per service.
  if (entry.balance && low > 0 && entry.balance.amount < low && Date.now() - (reminded.get(p.id) ?? 0) > 6 * 3600_000) {
    reminded.set(p.id, Date.now());
    toast(`「${p.name}」的余额只剩 ${balanceText(entry.balance)} 了，AI 回话可能会停，记得充值`);
  }
}

/** Checks every service now and every 3 hours (called once at start). */
export function watchBalances(list: () => Provider[]) {
  const run = () => list().forEach((p) => void checkBalance(p));
  setTimeout(run, 20_000);
  setInterval(run, 3 * 3600_000);
}
