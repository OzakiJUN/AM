import { useRef, useState, type ReactNode } from 'react';
import { Bell, Check, ExternalLink, ImageUp, Info, Monitor, Moon, Palette, Plus, RotateCcw, Server, Shield, Sun, Trash2, Type } from 'lucide-react';
import { motion } from 'motion/react';
import { ACCENTS, imageFileToDataURL, useTheme } from '@/lib/theme';
import { current, removeServer, switchServer, useApp, useCurrent } from '@/lib/store';
import { usePrefs } from '@/lib/prefs';
import { openUrl } from '@/lib/platform';
import { Button, Empty, IdentityChip, Segmented, Slider, Toggle, ask, cx, spring } from '@/ui';
import { ServerAvatar, UserAvatar } from './media';

type Tab = 'appearance' | 'servers' | 'privacy' | 'notify' | 'about';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('appearance');
  const tabs: { id: Tab; label: string; Icon: typeof Palette }[] = [
    { id: 'appearance', label: '外观', Icon: Palette },
    { id: 'servers', label: '服务器', Icon: Server },
    { id: 'privacy', label: '隐私', Icon: Shield },
    { id: 'notify', label: '通知', Icon: Bell },
    { id: 'about', label: '关于', Icon: Info },
  ];
  return (
    <>
      <aside className="glass flex w-[220px] shrink-0 flex-col gap-1 rounded-3xl p-3">
        <h2 className="px-3 pt-2 pb-3 text-[1.2rem] font-semibold">设置</h2>
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cx(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
              'lift',
              tab === id ? 'bg-accent-100 font-medium text-accent-700 shadow-[var(--shadow-card)] dark:bg-white/10 dark:text-white' : 'hover:bg-white/60 dark:hover:bg-white/5',
            )}
          >
            <Icon size={18} /> {label}
          </button>
        ))}
      </aside>
      <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
          {tab === 'appearance' && <Appearance />}
          {tab === 'servers' && <Servers />}
          {tab === 'privacy' && <Privacy />}
          {tab === 'notify' && <Notify />}
          {tab === 'about' && <About />}
        </motion.div>
      </section>
    </>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-black/5 py-5 last:border-0 dark:border-white/5">
      <div className="min-w-[200px] flex-1">
        <div className="font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-[0.85rem] text-ink-soft dark:text-white/50">{desc}</div>}
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

function Appearance() {
  const t = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const colorRef = useRef<HTMLInputElement>(null);
  const custom = !ACCENTS.some((a) => a.color === t.accent);
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">外观</h2>
      <p className="mt-1 text-ink-soft dark:text-white/55">只影响这台设备。以后可以在创意工坊下载别人做好的主题。</p>

      <div className="mt-4">
        <Row title="主题模式">
          <Segmented
            id="mode"
            value={t.mode}
            onChange={(mode) => t.set({ mode })}
            options={[
              { value: 'light', label: <span className="flex items-center gap-1.5"><Sun size={15} />浅色</span> },
              { value: 'dark', label: <span className="flex items-center gap-1.5"><Moon size={15} />深色</span> },
              { value: 'system', label: <span className="flex items-center gap-1.5"><Monitor size={15} />跟随系统</span> },
            ]}
          />
        </Row>

        <Row title="主题色" desc="按钮、气泡、高亮都用这个颜色">
          <div className="flex flex-wrap items-center gap-2.5">
            {ACCENTS.map((a) => (
              <button
                key={a.color}
                onClick={() => t.set({ accent: a.color })}
                aria-label={a.name}
                title={a.name}
                className={cx('flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 transition ring-offset-white dark:ring-offset-[#1e1b36]', t.accent === a.color && 'ring-2 ring-[var(--accent)]')}
                style={{ background: a.color }}
              >
                {t.accent === a.color && <Check size={16} className="text-white" />}
              </button>
            ))}
            <button
              onClick={() => colorRef.current?.click()}
              aria-label="自定义颜色"
              title="自定义颜色"
              className={cx(
                'flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-white dark:ring-offset-[#1e1b36]',
                custom && 'ring-2 ring-[var(--accent)]',
              )}
              style={{ background: 'conic-gradient(#f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171)' }}
            >
              {custom && <Check size={16} className="text-white drop-shadow" />}
            </button>
            <input ref={colorRef} type="color" value={t.accent} onChange={(e) => t.set({ accent: e.target.value })} className="sr-only" />
          </div>
        </Row>

        <Row title="背景图片" desc="用你自己的图片当聊天窗口的背景">
          <div className="flex items-center gap-3">
            <div
              className="h-16 w-28 overflow-hidden rounded-xl border border-black/10 bg-gradient-to-br from-accent-100 via-white to-violet-100 bg-cover bg-center dark:border-white/10 dark:from-accent/30 dark:via-[#1b1733] dark:to-violet-500/20"
              style={t.background ? { backgroundImage: `url("${t.background}")` } : undefined}
              aria-label="背景预览"
            />
            <div className="flex flex-col gap-2">
              <Button size="sm" variant="soft" onClick={() => fileRef.current?.click()}>
                <ImageUp size={15} /> 导入图片
              </Button>
              {t.background && (
                <Button size="sm" variant="ghost" onClick={() => t.set({ background: '' })}>
                  <RotateCcw size={15} /> 恢复默认
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) t.set({ background: await imageFileToDataURL(f) });
                e.target.value = '';
              }}
            />
          </div>
        </Row>

        {t.background && (
          <>
            <Row title="背景模糊">
              <div className="w-56"><Slider label="背景模糊" value={t.bgBlur} min={0} max={30} step={1} onChange={(bgBlur) => t.set({ bgBlur })} /></div>
              <span className="w-10 text-right text-[0.85rem] text-ink-soft tabular-nums dark:text-white/50">{t.bgBlur}</span>
            </Row>
            <Row title="背景遮罩" desc="调高一点，文字更容易看清">
              <div className="w-56"><Slider label="背景遮罩" value={t.bgDim} min={0} max={0.8} step={0.05} onChange={(bgDim) => t.set({ bgDim })} /></div>
              <span className="w-10 text-right text-[0.85rem] text-ink-soft tabular-nums dark:text-white/50">{Math.round(t.bgDim * 100)}%</span>
            </Row>
          </>
        )}

        <PortraitRow />

        <Row title="字体大小">
          <Type size={14} className="text-ink-soft" />
          <div className="w-48"><Slider label="字体大小" value={t.fontScale} min={0.85} max={1.25} step={0.05} onChange={(fontScale) => t.set({ fontScale })} /></div>
          <Type size={20} className="text-ink-soft" />
        </Row>
      </div>
    </div>
  );
}

function PortraitRow() {
  const pos = usePrefs((s) => s.portrait);
  const set = usePrefs((s) => s.setPortrait);
  return (
    <Row title="AI 立绘位置" desc="AI 聊天里立绘放在哪；收起后在右上角，点一下展开">
      <Segmented
        id="portrait-pos"
        value={pos}
        onChange={set}
        options={[
          { value: 'left', label: '靠左' },
          { value: 'center', label: '居中' },
          { value: 'right', label: '靠右' },
          { value: 'corner', label: '收起' },
        ]}
      />
    </Row>
  );
}

/** People I blocked on the current server. */
function Privacy() {
  const v = useCurrent();
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">隐私</h2>
      <p className="mt-1 text-ink-soft dark:text-white/55">
        服务器里的人都能直接私信你。屏蔽某人后你们互相发不了私信，频道里不受影响。下面是「{v?.name ?? '当前服务器'}」上你屏蔽的人。
      </p>
      <div className="mt-6 space-y-2">
        {v?.blocked.map((id) => {
          const u = v.users[id];
          return (
            <div key={id} className="card flex items-center gap-3 rounded-2xl bg-white/95 p-3 dark:bg-white/[0.06]">
              <UserAvatar user={u} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5"><span className="truncate font-medium">{u?.name ?? '…'}</span><IdentityChip user={u} short /></div>
                <div className="text-[0.82rem] text-ink-soft dark:text-white/50">@{u?.username}</div>
              </div>
              <Button size="sm" variant="soft" onClick={() => current().setBlocked(id, false)}>取消屏蔽</Button>
            </div>
          );
        })}
        {!v?.blocked.length && <Empty icon={<Shield size={26} />} title="没有屏蔽任何人" text="在成员列表或私信顶部可以屏蔽别人。" />}
      </div>
    </div>
  );
}

function Servers() {
  const servers = useApp((s) => s.servers);
  const sessions = useApp((s) => s.sessions);
  const currentId = useApp((s) => s.currentId);
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">服务器</h2>
      <p className="mt-1 text-ink-soft dark:text-white/55">可以同时加入好几个服务器，在会话列表顶上切换。</p>
      <div className="mt-6 space-y-2">
        {servers.map((s) => {
          const v = sessions[s.id];
          return (
            <div key={s.id} className="card flex items-center gap-3 rounded-2xl bg-white/95 p-3 dark:bg-white/[0.06]">
              <ServerAvatar name={v?.name ?? s.name} icon={v?.icon} serverId={s.id} size={42} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{v?.name ?? s.name} {s.id === currentId && <span className="ml-1 text-[0.78rem] text-accent">当前</span>}</div>
                <div className="text-[0.82rem] text-ink-soft dark:text-white/50">
                  {v?.me ? `@${v.me.username} · ` : ''}{{ connecting: '连接中', online: '已连接', offline: '已断开', logged_out: '未登录' }[v?.status ?? 'offline']}
                </div>
              </div>
              {s.id !== currentId && <Button size="sm" variant="soft" onClick={() => switchServer(s.id)}>切换</Button>}
              <Button
                size="sm"
                variant="ghost"
                aria-label="移除"
                onClick={async () => (await ask({ title: `从这台设备移除「${v?.name ?? s.name}」？`, text: '只是在本机退出并删掉这个服务器，账号和聊天记录都还在服务器上。', ok: '移除', danger: true })) !== null && removeServer(s.id)}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          );
        })}
      </div>
      <Button className="mt-4" variant="primary" onClick={() => useApp.setState({ view: 'welcome' })}><Plus size={16} /> 添加服务器</Button>
    </div>
  );
}

function Notify() {
  const [on, setOn] = useState(() => localStorage.getItem('am-notify') !== 'off');
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">通知</h2>
      <Row title="桌面通知" desc="窗口不在前台、或者在看别的会话时，新消息弹系统通知">
        <Toggle label="桌面通知" checked={on} onChange={(v) => { setOn(v); localStorage.setItem('am-notify', v ? 'on' : 'off'); }} />
      </Row>
    </div>
  );
}

function About() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">关于 AM</h2>
      <p className="mt-2 text-ink-soft dark:text-white/60">AM (AI Message) 是我和小克一起打造的新一代 AI 集成聊天工具。版本 {__APP_VERSION__}</p>
      <Button className="mt-5" variant="soft" onClick={() => openUrl('https://github.com/OzakiJUN/AM')}><ExternalLink size={16} /> GitHub</Button>
    </div>
  );
}
