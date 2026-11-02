import { useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, BookOpen, Coins, Fish, LogOut, ShoppingBag, Sparkles } from 'lucide-react';
import { session } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Game } from '@/lib/games';
import { GAME_INFO } from '@/lib/games';
import { CARD_RARITY, FISH_RARITY, moneyText, QUALITY, TOOLS, TOOL_KEYS, cardParts, collectionProgress, isBiting, toolEffect, type FishingAccount, type FishingAction, type FishingRules, type Species } from '@/lib/fishing';
import { Button, Spinner, cx, toastError } from '@/ui';
import { UserAvatar } from './media';
import './fishing.css';

// Catalogue-driven vector art: every species has its own shape, motif and number.
// No remote images or model service is needed to see the fish and cards.
export function FishArt({ fish, vertical = false }: { fish?: Species; vertical?: boolean }) {
  if (!fish) return <span className="text-3xl">🐟</span>;
  const n = Number(fish.id.slice(1));
  return <svg viewBox="0 0 160 100" role="img" aria-label={fish.name} className={cx('h-full w-full overflow-visible', vertical && 'rotate-90 scale-75')}>
    <g fill={fish.colour} stroke="#12354b" strokeWidth="2.3" strokeLinejoin="round">
      {fish.shape === 'star' ? <path d="M77 9 91 33 125 35 105 56 112 86 79 71 48 89 53 59 27 40 62 33Z" /> : fish.shape === 'ray' ? <path d="M16 52Q80-25 136 50Q96 96 78 66L61 96 66 66Q35 76 16 52Z" /> : <>
        <path d="M113 45 148 23 141 52 150 77 112 59Z" />
        <ellipse cx="73" cy="51" rx={fish.shape === 'long' ? 61 : fish.shape === 'whale' ? 57 : 45} ry={fish.shape === 'long' ? 14 : 29} />
        <path d="M65 26 78 9 91 27M72 70 92 86 96 69" />
      </>}
    </g>
    <g opacity=".68" fill="white">
      {Array.from({ length: 2 + fish.motif % 4 }, (_, i) => <ellipse key={i} cx={55 + i * 13} cy={36 + (i % 2) * 15} rx={3 + n % 4} ry={3 + fish.motif % 6} />)}
      {fish.rarity >= 2 && <path d="m97 14 3 7 8 3-8 3-3 7-3-7-8-3 8-3Z" />}
    </g>
    <circle cx="43" cy="45" r="6" fill="white" /><circle cx="41" cy="45" r="3.4" fill="#102538" />
    <path d="M28 57q8 7 14 0" stroke="#15364b" strokeWidth="2" fill="none" strokeLinecap="round" />
    {fish.motif === 1 && <path d="M58 25 62 76M81 24 85 78" stroke="#fff" strokeWidth="6" opacity=".6" />}
    {fish.motif === 2 && <path d="m71 27 7-13 7 13M93 27l6-11 6 11" fill="#fef08a" stroke="#9a6d2e" />}
    {fish.motif === 3 && <path d="M65 48h37M81 34v31" stroke="#2d5287" strokeWidth="3" />}
    {fish.motif === 4 && <path d="m54 68 13 12 12-12 13 12 12-12" fill="none" stroke="#fef3c7" strokeWidth="4" />}
    {fish.motif === 5 && <path d="M51 30q32-21 53 5" stroke="#fff" strokeWidth="4" fill="none" />}
    {fish.motif === 6 && <path d="M92 38v22m-10-14h20" stroke="#fff" strokeWidth="4" />}
    {fish.motif >= 7 && <g stroke="#fff" strokeWidth="2"><path d="m67 39 5 8-5 8-5-8Zm23 7 5 8-5 8-5-8Z" fill="none" /></g>}
  </svg>;
}
export function FishCard({ card, rules, count }: { card: string; rules: FishingRules; count?: number }) {
  const [tier, id] = cardParts(card); const f = rules.catalog.find((s) => s.id === id);
  return <div className={`fish-card fish-metal-${tier}`} title={`${CARD_RARITY[tier]}卡 · ${f?.name}`}>
    <div className="flex items-center justify-between text-[10px] font-semibold"><span>{CARD_RARITY[tier]}</span><span>#{id.slice(1)}</span></div>
    <div className="min-h-0 flex-1"><FishArt fish={f} /></div>
    <div className="truncate text-center text-xs font-semibold">{f?.name ?? id}</div>
    {count !== undefined && <div className="text-right text-[10px]">×{count}</div>}
  </div>;
}
export function FishingBadge({ tier, level }: { tier: number; level: number }) {
  const colors = ['#64748b', '#b97846', '#b7cadd', '#eab308', '#a78bfa'];
  return <div className="flex h-full min-h-16 flex-col items-center justify-center" title={`${CARD_RARITY[tier]}·${['', 'I', 'II', 'III', 'IV'][level]} 级收藏徽章`}>
    <svg viewBox="0 0 80 88" className="h-16 w-16" aria-hidden><path d="m22 50-6 33 24-12 24 12-6-33" fill={colors[tier]} opacity=".65" /><path d="m40 3 29 17-3 32-26 18-26-18-3-32Z" fill={colors[tier]} stroke="#fff" strokeWidth="3" /><path d="m40 14 5 13 14 1-11 9 4 14-12-8-12 8 4-14-11-9 14-1Z" fill="#fff6d8" /><text x="40" y="62" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">{['', 'I', 'II', 'III', 'IV'][level]}</text></svg>
    <span className="text-[10px]">{CARD_RARITY[tier]} · {level} 级</span>
  </div>;
}

export function FishingWindow({ v, g }: { v: SessionView; g: Game }) {
  const [rules, setRules] = useState<FishingRules>(); const [account, setAccount] = useState<FishingAccount>();
  const [page, setPage] = useState<'pond' | 'shop' | 'catalog'>('pond');
  const [tab, setTab] = useState<'sell' | 'tools' | 'cards'>('sell'); const [target, setTarget] = useState(-1);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const pending = useRef<{ signature: string; id: string } | null>(null);
  const s = session(v.id)!; const me = v.me?.id ?? ''; const pond = g.state.pond;
  const offset = useMemo(() => pond ? pond.now - Date.now() : 0, [pond?.now]);
  useEffect(() => {
    let live = true, loading = false;
    void s.fishingRules().then((r) => { if (live) setRules(r); }).catch((e: Error) => { if (live) setError(e.message); });
    const load = async () => {
      if (loading || !live) return; loading = true;
      try { if (g.status !== 'ended') await s.refreshGame(g.id); const a = await s.fishingAccount(); if (live) { setAccount(a); setError(''); } }
      catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 2000); const clock = setInterval(() => setNow(Date.now()), 500);
    return () => { live = false; clearInterval(timer); clearInterval(clock); };
  }, [s, g.id, g.status]);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true);
    try { await fn(); setAccount(await s.fishingAccount()); setError(''); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const shop = (action: FishingAction) => act(async () => {
    const signature = JSON.stringify(action); if (pending.current?.signature !== signature) pending.current = { signature, id: crypto.randomUUID() };
    const a = await s.fishingAction(action, pending.current.id); setAccount(a); pending.current = null;
  });
  if (!rules || !account || !pond) return <div className="space-y-3 p-8 text-center"><Spinner />{error && <p role="alert">{error}</p>}</div>;
  const serverNow = now + offset; const mine = pond.seats.findIndex((p) => p.user_id === me); const angler = pond.seats[mine];
  const bite = angler && isBiting(angler, serverNow); const countdown = angler ? Math.max(0, Math.ceil((bite ? angler.expires_at : angler.bite_at) - serverNow) / 1000) : 0;
  const coins = <span className="inline-flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-300"><Coins size={16} />{moneyText(account.coins)} <span className="text-xs font-normal">金币</span></span>;
  return <div className="fishing-game space-y-3" data-testid="fishing-game">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><div className="text-xs uppercase tracking-[.22em] text-cyan-700 dark:text-cyan-300">STELLAR POND · 12 SEATS</div><h3 className="text-xl font-semibold">把星光钓回家</h3></div>{coins}
    </div>
    <div className="flex gap-2" role="tablist" aria-label="钓鱼界面">
      {([['pond', '鱼塘', Anchor], ['shop', '商店', ShoppingBag], ['catalog', '鱼类图鉴', BookOpen]] as const).map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={page === id} onClick={() => setPage(id)} className={cx('flex items-center gap-1.5 rounded-full px-4 py-2 text-sm', page === id ? 'bg-cyan-800 text-white' : 'bg-black/5 dark:bg-white/5')}><Icon size={15} />{label}</button>)}
    </div>
    {pond.catching_up && <p className="text-xs text-amber-600">服务器正在补结算离线收益，完成后可迁移存档或离座。</p>}
    {account.frozen && <p className="text-xs text-ink-soft">当前是跨服同步副本。操作时会接续存档，需能连接最近挂机的服务器。</p>}
    {error && <p role="alert" className="text-sm text-red-500">连接未刷新：{error}</p>}
    {g.status === 'ended' && <p className="rounded-xl bg-black/5 p-3">鱼塘已关闭，账号的鱼、金币、工具和卡片都保留了。</p>}
    {page === 'pond' ? <div className="grid gap-4 md:grid-cols-[1fr_210px]">
      <div className="fish-pond relative aspect-square w-full rounded-[2rem]" aria-label="12 座方形鱼塘">
        <div className="fish-water absolute inset-[14%] overflow-hidden rounded-[2rem] border-4 border-cyan-100/30">
          <div className="absolute inset-0 flex flex-col items-center justify-center text-cyan-50/80"><Sparkles size={30} /><span className="mt-2 text-sm tracking-[.4em]">星屿鱼塘</span><span className="mt-1 text-xs opacity-70">{g.players.length} / 12 · 不限时</span></div>
          {pond.seats.filter((p) => p.user_id !== '0').map((p, i) => <div key={p.user_id} className={cx('fish-float', isBiting(p, serverNow) && 'fish-biting')} style={{ left: `${22 + i * 23 % 65}%`, top: `${18 + i * 31 % 65}%` }}><i /><b /></div>)}
        </div>
        {pond.seats.map((p, i) => {
          const side = Math.floor(i / 3), pos = 25 + i % 3 * 25;
          const style = side === 0 ? { left: `${pos}%`, top: '7%' } : side === 1 ? { left: '93%', top: `${pos}%` } : side === 2 ? { left: `${100 - pos}%`, top: '93%' } : { left: '7%', top: `${100 - pos}%` };
          const empty = p.user_id === '0', biting = isBiting(p, serverNow);
          return <button key={i} style={style} disabled={busy || g.status === 'ended'} onClick={() => empty ? void act(() => s.actGame(g.id, { action: 'sit', target: i })) : setTarget(i)} title={empty ? `坐到 ${i + 1} 号` : `${v.users[p.user_id]?.name ?? '玩家'}${biting ? '，鱼上钩了' : ''}`} aria-label={empty ? `坐到 ${i + 1} 号` : `选择 ${i + 1} 号 ${v.users[p.user_id]?.name ?? '玩家'}`} className={cx('absolute flex w-[19%] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-xl p-1 text-[10px]', target === i ? 'bg-amber-100 ring-2 ring-amber-400' : 'bg-white/80', p.user_id === me && 'ring-2 ring-cyan-500')}>
            {empty ? <div className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-cyan-600 text-lg text-cyan-800">+</div> : <UserAvatar user={v.users[p.user_id]} size={30} />}
            <span className="w-full truncate text-slate-700">{i + 1} · {empty ? '空座' : p.user_id === me ? '你' : v.users[p.user_id]?.name ?? '玩家'}</span>
            {biting && <span className="font-bold text-orange-600">上钩了！</span>}
          </button>;
        })}
      </div>
      <aside className="flex flex-col gap-3 rounded-2xl bg-cyan-950/[.04] p-4 dark:bg-cyan-100/5">
        <div className="text-xs font-semibold tracking-wider text-cyan-700 dark:text-cyan-300">你的钓鱼台</div>
        <p role="status" className="text-sm">{g.status === 'ended' ? '鱼塘已关闭' : mine < 0 ? '点一个空座坐下，就会自动抛竿。' : bite ? `鱼上钩了！还有 ${Math.ceil(countdown)} 秒` : `静候水面波动，约 ${Math.ceil(countdown)} 秒`}</p>
        <Button variant="primary" disabled={busy || !bite || g.status === 'ended'} onClick={() => act(() => s.actGame(g.id, { action: 'reel' }))}><Fish size={16} />收杆</Button>
        <Button variant="soft" onClick={() => setPage('shop')}><ShoppingBag size={16} />商店</Button>
        {target >= 0 && <div className="rounded-xl bg-white/70 p-3 text-sm dark:bg-white/5"><div className="mb-2">{target + 1} 号 · {v.users[pond.seats[target].user_id]?.name ?? '空座'}</div><Button size="sm" disabled={busy || mine < 0 || target === mine || !isBiting(pond.seats[target], serverNow) || !account.equipped?.includes('glove') || account.steal_at > serverNow} onClick={() => act(() => s.actGame(g.id, { action: 'steal', target }))}>用手套偷鱼</Button></div>}
        <div className="space-y-1 text-xs text-ink-soft"><div>已装备 {(account.equipped ?? []).length}/2</div>{(account.equipped ?? []).map((k) => <div key={k}>{TOOLS[k as keyof typeof TOOLS]} · {QUALITY[account.tools[k] - 1]}</div>)}<div>自动收杆 {account.auto_at > serverNow ? `${Math.ceil((account.auto_at - serverNow) / 1000)}s` : '就绪'}</div><div>手套 {account.steal_at > serverNow ? `${Math.ceil((account.steal_at - serverNow) / 1000)}s` : '就绪'}</div><div>结界 {account.ward_at > serverNow ? `${Math.ceil((account.ward_at - serverNow) / 1000)}s` : '就绪'}</div></div>
        {mine >= 0 && g.status !== 'ended' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => s.gameStep(g.id, 'leave'))}><LogOut size={14} />离座</Button>}
        {g.hostId === me && g.status !== 'ended' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => s.gameStep(g.id, 'end'))}>关闭鱼塘</Button>}
      </aside>
    </div> : page === 'catalog' ? <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-auto md:grid-cols-5">{rules.catalog.map((f) => <div key={f.id} className="rounded-xl border border-cyan-500/10 bg-cyan-50/40 p-2 dark:bg-cyan-900/10"><div className="h-20"><FishArt fish={f} /></div><div className="truncate text-sm font-semibold">{f.name}</div><div className="text-[11px] text-ink-soft">{FISH_RARITY[f.rarity]} · 均长 {f.average_m.toFixed(2)} m</div><p className="mt-1 text-[10px] text-ink-soft">{f.description}</p></div>)}</div> : <div className="space-y-3">
      <div className="flex flex-wrap gap-2">{([['sell', '鱼篓 / 卖鱼'], ['tools', '装备商店'], ['cards', '卡包与收藏']] as const).map(([id, text]) => <Button key={id} variant={tab === id ? 'primary' : 'soft'} onClick={() => setTab(id)}>{text}</Button>)}</div>
      <div className="max-h-[52vh] overflow-auto">
        {tab === 'sell' && <FishInventory account={account} rules={rules} busy={busy} sell={(ids) => shop({ action: 'sell', fishIds: ids })} />}
        {tab === 'tools' && <div className="space-y-3"><p className="text-xs text-ink-soft">最多装两类工具，同类品质会替换。升级按全价购买，冷却随账号保留，换装不会重置。</p>{TOOL_KEYS.map((k) => <div key={k} className="rounded-xl border border-cyan-500/15 p-3"><div className="mb-2 flex items-center justify-between"><h4 className="font-semibold">{TOOLS[k]}</h4>{account.tools[k] > 0 && <Button size="sm" disabled={busy || (!account.equipped?.includes(k) && (account.equipped?.length ?? 0) >= 2)} onClick={() => shop({ action: account.equipped?.includes(k) ? 'unequip' : 'equip', item: k })}>{account.equipped?.includes(k) ? '卸下' : '装备'}</Button>}</div><div className="grid gap-2 sm:grid-cols-5">{QUALITY.map((q, i) => <div key={q} className="rounded-xl bg-black/[.03] p-2 text-xs dark:bg-white/5"><div className="font-semibold">{q}</div><p className="my-1 min-h-12 text-ink-soft">{toolEffect(rules, k, i + 1)}</p><Button size="sm" disabled={busy || (account.tools[k] ?? 0) >= i + 1 || account.coins < rules.tool_prices[i]} onClick={() => shop({ action: 'buy_tool', item: k, quality: i + 1 })}>{(account.tools[k] ?? 0) === i + 1 ? '已拥有' : (account.tools[k] ?? 0) > i + 1 ? '已有更高品质' : `${rules.tool_prices[i]} 币`}</Button></div>)}</div></div>)}</div>}
        {tab === 'cards' && <div className="space-y-4"><div className="flex flex-wrap items-center gap-2"><Button disabled={busy || account.coins < rules.pack_price} onClick={() => shop({ action: 'buy_pack' })}>买卡包 · {rules.pack_price} 币</Button><Button variant="primary" disabled={busy || account.packs < 1} onClick={() => shop({ action: 'open_pack' })}>开一包 · 剩余 {account.packs}</Button><span className="text-xs text-ink-soft">每包四张，重复卡计数</span></div>
          {!!account.opened?.length && <div className="rounded-xl bg-amber-300/10 p-3"><div className="mb-2 text-sm">刚刚获得</div><div className="grid grid-cols-4 gap-2">{account.opened.map((key, i) => <FishCard key={i} card={key} rules={rules} />)}</div></div>}
          <div className="grid grid-cols-5 gap-2">{collectionProgress(account).map((n, i) => <div key={i} className="rounded-xl bg-black/5 p-2 text-center text-xs dark:bg-white/5"><div>{CARD_RARITY[i]}卡</div><div className="my-1 font-semibold">{n}/100</div><progress value={n} max={100} className="w-full accent-cyan-600" />{account.badges[i] > 0 && <FishingBadge tier={i} level={account.badges[i]} />}</div>)}</div>
          <div className="grid grid-cols-4 gap-2 md:grid-cols-6">{Object.entries(account.cards).filter(([, n]) => n > 0).sort().map(([key, n]) => <FishCard key={key} card={key} rules={rules} count={n} />)}</div>
          <p className="text-xs text-ink-soft">卡片档位概率：{CARD_RARITY.map((n, i) => `${n} ${Math.round(rules.card_weights[i] / rules.card_weights.reduce((a, b) => a + b, 0) * 10000) / 100}%`).join(' · ')}。每档收藏满 25、50、75、100 种，自动授予 I–IV 级徽章。</p>
        </div>}
      </div>
    </div>}
    {account.last && <div className="rounded-xl bg-amber-100/60 px-3 py-2 text-sm text-amber-950 dark:bg-amber-300/10 dark:text-amber-100" role="status">{account.last}</div>}
    <details className="text-xs text-ink-soft"><summary className="cursor-pointer">完整玩法与概率</summary><p className="mt-2 leading-relaxed">{GAME_INFO.fishing.rules}</p><p className="mt-2">等待 {rules.wait_min_seconds}–{rules.wait_max_seconds} 秒，上钩窗口 {rules.bite_seconds} 秒。鱼 / 钱袋 / 卡片 / 卡包概率 {rules.loot_weights.map((n) => `${n / rules.loot_weights.reduce((a, b) => a + b, 0) * 100}%`).join(' / ')}。鱼种稀有度权重 {rules.fish_weights.join(' / ')}，长度按连续分布抽取，实际长度参与价格计算。服务端持续挂机，手套自动偷鱼，结界自动防御。</p></details>
  </div>;
}
function FishInventory({ account, rules, busy, sell }: { account: FishingAccount; rules: FishingRules; busy: boolean; sell: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fish = account.fish ?? []; const ids = fish.filter((f) => selected.has(f.id)).map((f) => f.id);
  return <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => setSelected(new Set(fish.map((f) => f.id)))}>全选 {fish.length}/{rules.inventory_limit}</Button><Button size="sm" onClick={() => setSelected(new Set())}>清空</Button><Button variant="primary" disabled={busy || !ids.length} onClick={() => sell(ids)}>卖出所选 · {moneyText(fish.filter((f) => selected.has(f.id)).reduce((n, f) => n + f.value, 0))} 币</Button></div>{!fish.length && <p className="py-10 text-center text-ink-soft">鱼篓还是空的，去鱼塘等一圈涟漪吧。</p>}<div className="grid gap-2 sm:grid-cols-3">{fish.map((f) => { const species = rules.catalog.find((s) => s.id === f.species); return <label key={f.id} className={cx('cursor-pointer rounded-xl border p-2', selected.has(f.id) ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20' : 'border-black/10 dark:border-white/10')}><input type="checkbox" checked={selected.has(f.id)} onChange={(e) => setSelected((old) => { const n = new Set(old); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} className="accent-cyan-700" /><div className="h-20"><FishArt fish={species} /></div><div className="truncate text-sm font-semibold">{species?.name}</div><div className="text-xs text-ink-soft">{f.length_m.toFixed(2)} m · {moneyText(f.value)} 币</div></label>; })}</div></div>;
}
