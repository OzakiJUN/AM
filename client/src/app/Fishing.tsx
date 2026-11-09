import { useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, BookOpen, Coins, Fish, LogOut, ShoppingBag, Timer, Hand } from 'lucide-react';
import { session } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Game } from '@/lib/games';
import { GAME_INFO } from '@/lib/games';
import { CARD_RARITY, FISH_RARITY, moneyText, QUALITY, TOOLS, TOOL_KEYS, collectionProgress, isBiting, isGlove, gloveStats, toolEffect, type FishingAccount, type FishingAction, type FishingRules, type Species } from '@/lib/fishing';
import { Button, Spinner, cx, toastError } from '@/ui';
import { UserAvatar } from './media';
import { FishArt, FishCard, FishingBadge, PondEmblem, PondScene, ToolIcon, seatSpot } from './FishingArt';
import { RARITY_WATER } from '@/lib/fishArt';
import type { CSSProperties } from 'react';
import './fishing.css';

export { FishArt, FishCard, FishingBadge } from './FishingArt';

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
  const bite = angler && isBiting(angler, serverNow); const gloves = gloveStats(rules, account);
  const coins = <span className="fishing-wallet-amount"><Coins size={15} />{moneyText(account.coins)}<small>金币</small></span>;
  const seated = pond.seats.filter((p) => p.user_id !== '0').length;
  const status = g.status === 'ended' ? '鱼塘已关闭' : mine < 0 ? '选一个空座，开始钓鱼' : bite ? '鱼上钩了，正在自动入篓' : '浮漂轻晃，等待上钩';
  return <div className="fishing-game" data-testid="fishing-game">
    <header className="fishing-hero">
      <div className="flex min-w-0 items-center gap-3"><PondEmblem size={46} /><div className="min-w-0"><h3 className="fishing-title">把星光钓回家</h3><p className="fishing-subtitle">星屿鱼塘 · 12 人共享 · 离线也在钓</p></div></div>
      <div className="fishing-chips"><span className="fishing-chip"><Fish size={14} />{(account.fish ?? []).length}/{rules.inventory_limit}</span><span className="fishing-wallet">{coins}</span></div>
    </header>
    <div className="fishing-tabs" role="tablist" aria-label="钓鱼界面">
      {([['pond', '鱼塘', Anchor], ['shop', '商店', ShoppingBag], ['catalog', '鱼类图鉴', BookOpen]] as const).map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={page === id} onClick={() => setPage(id)} className={cx('fishing-tab', page === id && 'is-active')}><Icon size={15} />{label}</button>)}
    </div>
    {pond.catching_up && <p className="fishing-note is-warn">服务器正在补结算离线收益，完成后可迁移存档或离座。</p>}
    {account.frozen && <p className="fishing-note">当前是跨服同步副本。操作时会接续存档，需能连接最近挂机的服务器。</p>}
    {error && <p role="alert" className="fishing-note is-bad">连接未刷新：{error}</p>}
    {g.status === 'ended' && <p className="fishing-note">鱼塘已关闭，账号的鱼、金币、工具和卡片都保留了。</p>}
    {page === 'pond' ? <div className="fishing-layout">
      <section className="fishing-stage">
        <div className="fishing-stage-caption"><span><i />星屿鱼塘 · 夜</span><span>{seated}/12 已入座 · 不限时</span></div>
        <div className="fish-pond" aria-label="12 座方形鱼塘">
          <PondScene lines={pond.seats.flatMap((p, i) => p.user_id === '0' ? [] : [{ i, mine: p.user_id === me, bite: isBiting(p, serverNow) }])} />
          <div className="fish-pond-center" aria-hidden><span>静候一圈涟漪</span><small>每一竿，都有新的惊喜</small></div>
          {pond.seats.map((p, i) => {
            const [x, y] = seatSpot(i).seat;
            const empty = p.user_id === '0', biting = !empty && isBiting(p, serverNow);
            const name = v.users[p.user_id]?.name ?? '玩家';
            return <button key={i} style={{ left: `${x}%`, top: `${y}%` }} disabled={busy || g.status === 'ended'} onClick={() => empty ? void act(() => s.actGame(g.id, { action: 'sit', target: i })) : setTarget(i)} title={empty ? `坐到 ${i + 1} 号` : `${name}${biting ? '，鱼上钩了' : ''}`} aria-label={empty ? `坐到 ${i + 1} 号` : `选择 ${i + 1} 号 ${name}`} className={cx('fish-seat', empty && 'is-empty', target === i && 'is-selected', p.user_id === me && 'is-mine', biting && 'has-bite')}>
              {empty ? <span className="fish-seat-plus">+</span> : <UserAvatar user={v.users[p.user_id]} size={24} />}
              <span className="fish-seat-name">{empty ? `${i + 1} 号` : p.user_id === me ? '你' : name}</span>
              {biting && <span className="fish-seat-bite">上钩!</span>}
            </button>;
          })}
        </div>
        <p className="fishing-stage-hint">点空座入座 · 点别的玩家可以用手套偷鱼 · 关掉窗口也会继续钓</p>
      </section>
      <aside className="fishing-console">
        <div className={cx('fishing-panel fishing-catch', bite && 'is-biting')}>
          <div className="fishing-eyebrow"><Timer size={13} />{mine >= 0 ? `${mine + 1} 号钓台 · 你的鱼竿` : '你的钓台'}</div>
          <div className="fishing-rod-art" aria-hidden><RodArt bite={!!bite} idle={mine < 0 || g.status === 'ended'} /></div>
          <p role="status" className="fishing-catch-label">{status}</p>
          {!bite && mine >= 0 && g.status !== 'ended' && <div className="fishing-waiting" aria-label="等待上钩"><span /><span /><span /><small>看水面，等鱼来</small></div>}
          <div className="fishing-reel" data-testid="auto-fishing"><Fish size={16} />{g.status === 'ended' ? '已停止钓鱼' : mine < 0 ? '入座后自动钓鱼' : '自动钓鱼中'}</div>
        </div>
        <div className="fishing-panel fishing-loadout">
          <div className="flex items-center justify-between"><span className="fishing-eyebrow">随身装备 · {(account.equipped ?? []).length}/2</span><button className="fishing-link" onClick={() => { setPage('shop'); setTab('tools'); }}>管理</button></div>
          {[0, 1].map((i) => { const k = account.equipped?.[i]; const cd = isGlove(k) ? account.steal_at : k === 'ward' ? account.ward_at : 0;
            return <div key={i} className={cx('fishing-tool-slot', !k && 'is-empty')}><span className="fishing-tool-icon"><ToolIcon kind={k} size={26} /></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">{k ? TOOLS[k as keyof typeof TOOLS] : '空装备位'}</div><span className={cx('fishing-quality', k && `q${account.tools[k]}`)}>{k ? QUALITY[account.tools[k] - 1] : '去商店挑一件'}</span></div>{k && <span className="fishing-tool-cd">{k === 'auto' ? (rules.double_fish_percent ? `${rules.double_fish_percent[account.tools[k] - 1]}% 双鱼` : '服务端待更新') : cd > serverNow ? `${Math.ceil((cd - serverNow) / 1000)}s` : '就绪'}</span>}</div>;
          })}
          <Button variant="soft" size="sm" onClick={() => { setPage('shop'); setTab('sell'); }}><ShoppingBag size={14} />鱼篓与商店 · {(account.fish ?? []).length} 条鱼</Button>
          {gloves.equipped && <p className="fishing-small" data-testid="glove-summary">偷鱼：最多 {gloves.count} 条 · CD {gloves.cooldown} 秒 · 偷鱼售价 +{gloves.bonus}%{account.steal_at > serverNow ? ` · 冷却 ${Math.ceil((account.steal_at - serverNow) / 1000)} 秒` : ' · 就绪'}</p>}
        </div>
        {target >= 0 && <div className="fishing-panel fishing-target"><div className="mb-2 flex items-center gap-2 text-xs">{pond.seats[target].user_id !== '0' && <UserAvatar user={v.users[pond.seats[target].user_id]} size={22} />}<span>{target + 1} 号 · {v.users[pond.seats[target].user_id]?.name ?? '空座'}</span></div><Button size="sm" disabled={busy || mine < 0 || target === mine || pond.seats[target].user_id === '0' || g.status === 'ended' || !gloves.equipped || (account.fish?.length ?? 0) >= rules.inventory_limit || account.steal_at > serverNow} onClick={() => act(() => s.actGame(g.id, { action: 'steal', target }))}><Hand size={13} />用手套偷鱼</Button></div>}
        <div className="fishing-exit-actions">
          {mine >= 0 && g.status !== 'ended' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => s.gameStep(g.id, 'leave'))}><LogOut size={13} />离座</Button>}
          {g.hostId === me && g.status !== 'ended' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => s.gameStep(g.id, 'end'))}>关闭鱼塘</Button>}
        </div>
      </aside>
    </div> : page === 'catalog' ? <div className="fishing-catalog">{rules.catalog.map((f) => <div key={f.id} className="fish-tile" style={waterStyle(f.rarity)}><div className="fish-tile-top"><span className={`fish-rarity r${f.rarity}`}>{FISH_RARITY[f.rarity]}</span><span>No.{f.id.slice(1)}</span></div><div className="fish-tile-art"><FishArt fish={f} /></div><div className="fish-tile-name">{f.name}</div><div className="fish-tile-meta">均长 {f.average_m.toFixed(2)} m</div><p className="fish-tile-desc">{f.description}</p></div>)}</div> : <div className="space-y-3">
      <div className="fishing-segment">{([['sell', '鱼篓 / 卖鱼'], ['tools', '装备商店'], ['cards', '卡包与收藏']] as const).map(([id, text]) => <button key={id} type="button" aria-pressed={tab === id} className={cx('fishing-segment-item', tab === id && 'is-active')} onClick={() => setTab(id)}>{text}</button>)}</div>
      <div className="fishing-shop-body">
        {tab === 'sell' && <FishInventory account={account} rules={rules} busy={busy} sell={(ids) => shop({ action: 'sell', fishIds: ids })} />}
        {tab === 'tools' && <div className="space-y-3"><p className="fishing-small">最多装两类工具；三种手套可单独用也可以组合，共用偷鱼冷却。成功率和破盾取已装手套里最高的品质，其余效果分别算。升级要全价买，换装不重置冷却。</p>{TOOL_KEYS.map((k) => <div key={k} className="fishing-panel fishing-shop-tool"><div className="mb-2 flex items-center gap-3"><span className="fishing-tool-icon is-big"><ToolIcon kind={k} size={34} /></span><div className="min-w-0 flex-1"><h4 className="font-semibold">{TOOLS[k]}</h4><span className={cx('fishing-quality', account.tools[k] > 0 && `q${account.tools[k]}`)}>{account.tools[k] ? `已有 · ${QUALITY[account.tools[k] - 1]}` : '还没有'}{account.equipped?.includes(k) ? ' · 装备中' : ''}</span></div>{account.tools[k] > 0 && <Button size="sm" disabled={busy || (!account.equipped?.includes(k) && (account.equipped?.length ?? 0) >= 2)} onClick={() => shop({ action: account.equipped?.includes(k) ? 'unequip' : 'equip', item: k })}>{account.equipped?.includes(k) ? '卸下' : '装备'}</Button>}</div><div className="fishing-quality-row">{QUALITY.map((q, i) => <div key={q} className={cx('fishing-quality-step', `q${i + 1}`, (account.tools[k] ?? 0) >= i + 1 && 'is-owned')}><div className="fishing-quality-name">{q}</div><p className="fishing-quality-effect">{toolEffect(rules, k, i + 1)}</p><Button size="sm" disabled={busy || (account.tools[k] ?? 0) >= i + 1 || account.coins < rules.tool_prices[i]} onClick={() => shop({ action: 'buy_tool', item: k, quality: i + 1 })}>{(account.tools[k] ?? 0) === i + 1 ? '已拥有' : (account.tools[k] ?? 0) > i + 1 ? '已有更高品质' : `${rules.tool_prices[i]} 币`}</Button></div>)}</div></div>)}</div>}
        {tab === 'cards' && <div className="space-y-4"><div className="fishing-panel flex flex-wrap items-center gap-3"><PackArt /><div className="min-w-0 flex-1"><div className="font-semibold">鱼卡卡包</div><span className="fishing-small">每包四张，重复的卡也会计数</span></div><Button disabled={busy || account.coins < rules.pack_price} onClick={() => shop({ action: 'buy_pack' })}>买卡包 · {rules.pack_price} 币</Button><Button variant="primary" disabled={busy || account.packs < 1} onClick={() => shop({ action: 'open_pack' })}>开一包 · 剩余 {account.packs}</Button></div>
          {!!account.opened?.length && <div className="fishing-opened"><div className="mb-2 text-sm font-semibold">刚刚获得</div><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{account.opened.map((key, i) => <div key={i} className="fishing-reveal" style={{ animationDelay: `${i * 90}ms` }}><FishCard card={key} rules={rules} /></div>)}</div></div>}
          <div className="fishing-progress">{collectionProgress(account).map((n, i) => <div key={i} className={`fishing-progress-item fish-metal-text-${i}`}><div className="flex items-baseline justify-between"><span className="font-semibold">{CARD_RARITY[i]}卡</span><span className="text-xs">{n}/100</span></div><div className="fishing-bar"><i style={{ width: `${n}%` }} /></div>{account.badges[i] > 0 && <FishingBadge tier={i} level={account.badges[i]} />}</div>)}</div>
          <div className="fishing-card-grid">{Object.entries(account.cards).filter(([, n]) => n > 0).sort().map(([key, n]) => <FishCard key={key} card={key} rules={rules} count={n} />)}</div>
          <p className="fishing-small">卡片档位概率：{CARD_RARITY.map((n, i) => `${n} ${Math.round(rules.card_weights[i] / rules.card_weights.reduce((a, b) => a + b, 0) * 10000) / 100}%`).join(' · ')}。每档收藏满 25、50、75、100 种，自动授予 I–IV 级徽章。</p>
        </div>}
      </div>
    </div>}
    {account.last && <div className="fishing-last" role="status"><span className="fishing-last-fish"><FishArt fish={lastSpecies(rules, account.last)} /></span>{account.last}</div>}
    <details className="fishing-small"><summary className="cursor-pointer">完整玩法与概率</summary><p className="mt-2 leading-relaxed">{GAME_INFO.fishing.rules}</p><p className="mt-2">等待 {rules.wait_min_seconds}–{rules.wait_max_seconds} 秒，上钩即自动入篓；手套基础冷却 {rules.steal_base_cd_seconds ?? rules.steal_cd_seconds[0]} 秒。鱼 / 钱袋 / 卡片 / 卡包概率 {rules.loot_weights.map((n) => `${n / rules.loot_weights.reduce((a, b) => a + b, 0) * 100}%`).join(' / ')}。鱼种稀有度权重 {rules.fish_weights.join(' / ')}，长度按连续分布抽取，实际长度参与价格计算。服务端持续挂机，手套自动偷鱼，结界自动防御。</p></details>
  </div>;
}

const waterStyle = (rarity: number) => ({ '--w1': RARITY_WATER[rarity]?.[0], '--w2': RARITY_WATER[rarity]?.[1] }) as CSSProperties;

/** The species named in the last-catch line, for its little picture. */
function lastSpecies(rules: FishingRules, text: string): Species | undefined {
  return rules.catalog.filter((f) => text.includes(f.name)).sort((a, b) => b.name.length - a.name.length)[0];
}

/** The status card's rod: bends and shakes when something bites. */
function RodArt({ bite, idle }: { bite: boolean; idle: boolean }) {
  return <svg viewBox="0 0 120 64" className={cx('fishing-rod', bite && 'is-bite', idle && 'is-idle')}>
    <path d="M0 52 C20 49 40 55 60 52 C80 49 100 55 120 52 V64 H0 Z" fill="#7cc4e8" opacity=".35" />
    <path d="M6 57 C22 55 38 59 54 57 M66 59 C82 57 98 61 114 59" stroke="#7cc4e8" strokeOpacity=".6" strokeWidth="1" fill="none" strokeLinecap="round" />
    <path d="M8 50 C30 36 52 20 78 10" stroke="#8a5a2c" strokeWidth="3.4" strokeLinecap="round" fill="none" className="fishing-rod-pole" />
    <path d="M78 10 C88 22 94 34 96 48" stroke="currentColor" strokeOpacity=".45" strokeWidth="1" fill="none" className="fishing-rod-line" />
    <g className="fishing-rod-float"><path d="M92 48 a4 4 0 0 1 8 0 Z" fill="#ff6b6b" /><path d="M92 48 a4 4 0 0 0 8 0 Z" fill="#fff" /></g>
    {bite && <g fill="none" stroke="#ffd166" strokeWidth="1.6"><ellipse cx="96" cy="52" rx="10" ry="3" className="fish-ripple" /><ellipse cx="96" cy="52" rx="16" ry="5" className="fish-ripple fish-ripple-2" /></g>}
    <circle cx="16" cy="45" r="4" fill="#5b3a1e" />
  </svg>;
}

function PackArt() {
  return <svg viewBox="0 0 48 56" width="40" height="46" aria-hidden><rect x="4" y="2" width="40" height="52" rx="7" fill="#2d3d7a" /><rect x="8" y="6" width="32" height="44" rx="5" fill="#167c74" /><path d="M14 28 c4 -6 12 -6 16 0 l6 -4 -1 4 1 4 -6 -4 c-4 6 -12 6 -16 0 Z" fill="#ffe29a" /><path d="M24 10 l2 4 4 1 -4 1 -2 4 -2 -4 -4 -1 4 -1 Z" fill="#fff" /><path d="M4 40 H44" stroke="#ffe29a" strokeWidth="2" strokeDasharray="3 3" /></svg>;
}

function FishInventory({ account, rules, busy, sell }: { account: FishingAccount; rules: FishingRules; busy: boolean; sell: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fish = account.fish ?? []; const ids = fish.filter((f) => selected.has(f.id)).map((f) => f.id);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="soft" onClick={() => setSelected(new Set(fish.map((f) => f.id)))}>全选 {fish.length}/{rules.inventory_limit}</Button><Button size="sm" variant="soft" onClick={() => setSelected(new Set())}>清空</Button><Button variant="primary" disabled={busy || !ids.length} onClick={() => sell(ids)}>卖出所选 · {moneyText(fish.filter((f) => selected.has(f.id)).reduce((n, f) => n + f.value, 0))} 币</Button></div>
    {!fish.length && <p className="py-10 text-center fishing-small">鱼篓还是空的，去鱼塘等一圈涟漪吧。</p>}
    <div className="fishing-basket">{fish.map((f) => { const species = rules.catalog.find((x) => x.id === f.species); return <label key={f.id} className={cx('fish-tile is-pick', selected.has(f.id) && 'is-selected')} style={waterStyle(species?.rarity ?? 0)}>
      <input type="checkbox" checked={selected.has(f.id)} onChange={(e) => setSelected((old) => { const n = new Set(old); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} className="fish-tile-check" />
      <div className="fish-tile-top"><span className={`fish-rarity r${species?.rarity ?? 0}`}>{FISH_RARITY[species?.rarity ?? 0]}</span></div>
      <div className="fish-tile-art"><FishArt fish={species} /></div>
      <div className="fish-tile-name">{species?.name}</div>
      <div className="fish-tile-meta">{f.length_m.toFixed(2)} m · <b>{moneyText(f.value)}</b> 币</div>
    </label>; })}</div>
  </div>;
}
