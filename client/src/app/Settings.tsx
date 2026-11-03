import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Check, ExternalLink, ImageUp, Info, Monitor, Moon, Palette, Plus, RotateCcw, Server, Shield, Sun, Trash2, Type, Volume2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { ACCENTS, GLASS_DEFAULTS, GLASS_STYLES, imageFileToDataURL, useTheme } from '@/lib/theme';
import { current, removeServer, switchServer, useApp, useCurrent } from '@/lib/store';
import { usePrefs } from '@/lib/prefs';
import { inTauri, notify, openUrl } from '@/lib/platform';
import { CATEGORY_LABEL, REMOTE_CATEGORIES } from '@/lib/ai/agent';
import type { Level, ToolCategory } from '@/lib/ai/persona';
import { newAllow, useRemote, type RemoteAllow } from '@/lib/ai/remote';
import { Button, ColorButton, Empty, IdentityChip, Segmented, Slider, Toggle, ask, cx, spring, toastError } from '@/ui';
import { APP_VERSION, cannotUpdate, checkGitHub, installUpdate, updateAvailable, useUpdate } from '@/lib/update';
import { ServerAvatar, UserAvatar } from './media';

type Tab = 'appearance' | 'sound' | 'servers' | 'privacy' | 'notify' | 'about';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('appearance');
  const tabs: { id: Tab; label: string; Icon: typeof Palette }[] = [
    { id: 'appearance', label: '外观', Icon: Palette },
    { id: 'sound', label: '声音', Icon: Volume2 },
    { id: 'servers', label: '服务器', Icon: Server },
    { id: 'privacy', label: '隐私', Icon: Shield },
    { id: 'notify', label: '通知与窗口', Icon: Bell },
    { id: 'about', label: '关于与更新', Icon: Info },
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
          {tab === 'sound' && <Sound />}
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

function Sound() {
  const volume = usePrefs((s) => s.musicVolume);
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">声音</h2>
      <Row title="音乐音量" desc="调整这台设备上「一首歌」和「歌单」小组件的播放音量。">
        <div className="w-48"><Slider label="音乐音量" min={0} max={100} step={1} value={volume}
          onChange={(musicVolume) => usePrefs.getState().set({ musicVolume })} /></div>
        <span className="w-12 text-right text-[0.85rem] tabular-nums">{volume}%</span>
      </Row>
    </div>
  );
}

function Appearance() {
  const t = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const custom = !ACCENTS.some((a) => a.color === t.accent);
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">外观</h2>
      <p className="mt-1 text-ink-soft dark:text-white/55">只影响这台设备。也可以在创意工坊里下载别人做好的主题，一键套用。</p>

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
            <ColorButton
              label="自定义颜色"
              value={t.accent}
              onChange={(accent) => t.set({ accent })}
              presets={ACCENTS.map((a) => a.color)}
              className={cx(
                'press flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-white dark:ring-offset-[#1e1b36]',
                custom && 'ring-2 ring-[var(--accent)]',
              )}
              style={{ background: 'conic-gradient(#f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171)' }}
            >
              {custom && <Check size={16} className="text-white drop-shadow" />}
            </ColorButton>
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

        <Row title="面板样式" desc="聊天窗口、列表这些面板叠在背景上的样子">
          <Segmented id="glass-style" value={t.glassStyle ?? 'frosted'} onChange={(glassStyle) => t.set({ glassStyle })} options={GLASS_STYLES} />
        </Row>
        {(t.glassStyle ?? 'frosted') !== 'solid' && (
          <>
            <Row title="面板透明度" desc="调低能看到更多背景，调高字更清楚">
              <div className="w-56"><Slider label="面板透明度" value={Math.round((1 - (t.glassOpacity ?? 0.74)) * 100)} min={0} max={80} step={2} onChange={(x) => t.set({ glassOpacity: 1 - x / 100 })} /></div>
              <span className="w-10 text-right text-[0.85rem] text-ink-soft tabular-nums dark:text-white/50">{Math.round((1 - (t.glassOpacity ?? 0.74)) * 100)}%</span>
            </Row>
            <Row title="面板模糊" desc="面板后面的背景模糊多少">
              <div className="w-56"><Slider label="面板模糊" value={t.glassBlur ?? 22} min={0} max={40} step={1} onChange={(glassBlur) => t.set({ glassBlur })} /></div>
              <span className="w-10 text-right text-[0.85rem] text-ink-soft tabular-nums dark:text-white/50">{t.glassBlur ?? 22}</span>
            </Row>
          </>
        )}
        {(t.glassStyle !== GLASS_DEFAULTS.glassStyle || t.glassOpacity !== GLASS_DEFAULTS.glassOpacity || t.glassBlur !== GLASS_DEFAULTS.glassBlur) && (
          <div className="flex justify-end pt-2">
            <Button size="sm" variant="ghost" onClick={() => t.set(GLASS_DEFAULTS)}><RotateCcw size={15} /> 面板恢复默认</Button>
          </div>
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
      <RemoteAIs />
    </div>
  );
}

/** 别人的 AI 操作这台电脑: off unless turned on here, per AI (docs/design.md §9). */
function RemoteAIs() {
  const v = useCurrent();
  const allow = useRemote((s) => s.allow);
  const setAllow = useRemote((s) => s.set);
  const [open, setOpen] = useState<string | null>(null);
  // AIs I never shared a chat with are not known yet: read the member directory.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let after = '';
      for (let i = 0; i < 10 && alive; i++) {
        const r = await current().listUsers('', after).catch(() => null);
        if (!r?.nextAfter) break;
        after = r.nextAfter;
      }
    })();
    return () => {
      alive = false;
    };
  }, [v?.id]);
  if (!v) return null;
  const ais = Object.values(v.users).filter((u) => (u.type === 'ai' || u.type === 'bot') && u.ownerId !== v.me?.id && !u.gone);
  const turnOn = async (key: string, name: string) => {
    const ok = await ask({
      title: `让「${name}」操作这台电脑？`,
      text: '它会通过服务器请这台电脑做事（看文件、运行命令、截图、点鼠标……），你在下面一项项决定允许、问你还是不行。默认每样都先问你。只影响这台电脑。',
      ok: '打开', danger: true,
    });
    if (ok === null) return;
    setAllow(key, newAllow(name));
    setOpen(key);
  };
  return (
    <div className="mt-10">
      <h3 className="text-[1.15rem] font-semibold">别人的 AI 操作这台电脑</h3>
      <p className="mt-1 text-[0.88rem] text-ink-soft dark:text-white/55">默认谁都不行。打开后，那个 AI（用它主人的模型）可以请这台电脑做你允许的事；它做的每一步都会显示在屏幕上方，按 F12 或点「停止」马上停。</p>
      <div className="mt-4 space-y-2">
        {!ais.length && <p className="text-[0.88rem] text-ink-soft dark:text-white/50">这个服务器上还没有别人的 AI。</p>}
        {ais.map((u) => {
          const key = `${v.id}|${u.id}`;
          const a = allow[key];
          return (
            <div key={u.id} className="card rounded-2xl bg-white/95 p-3 dark:bg-white/[0.06]">
              <div className="flex items-center gap-3">
                <UserAvatar user={u} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5"><span className="truncate font-medium">{u.name}</span><IdentityChip user={u} short /></div>
                  <div className="text-[0.82rem] text-ink-soft dark:text-white/50">{a ? '可以操作这台电脑（按下面的设置）' : '不能操作这台电脑'}</div>
                </div>
                {a && <Button size="sm" variant="ghost" onClick={() => setOpen(open === key ? null : key)}>{open === key ? '收起' : '权限'}</Button>}
                <Toggle label={`让 ${u.name} 操作这台电脑`} checked={!!a} onChange={(on) => (on ? turnOn(key, u.name) : setAllow(key, null))} />
              </div>
              {a && open === key && <RemoteLevels allow={a} onChange={(x) => setAllow(key, x)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RemoteLevels({ allow, onChange }: { allow: RemoteAllow; onChange: (a: RemoteAllow) => void }) {
  const setLevel = async (cat: ToolCategory, level: Level) => {
    // Raising always warns (Weiqi: the top level may be silent, but never without a warning).
    const rank = { deny: 0, ask: 1, allow: 2 } as const;
    if (rank[level] > rank[allow.levels[cat] ?? 'deny']) {
      const ok = await ask({
        title: level === 'allow' ? `让「${allow.name}」${CATEGORY_LABEL[cat].name}不用问你？` : `让「${allow.name}」可以${CATEGORY_LABEL[cat].name}？`,
        text: `${CATEGORY_LABEL[cat].hint}。这是别人的 AI，它听它主人和别人的话。${level === 'allow' ? '选「允许」后它做这类事不会再问你，只会在屏幕上方显示。' : ''}`,
        ok: '确定', danger: level === 'allow' || !!CATEGORY_LABEL[cat].risky,
      });
      if (ok === null) return;
    }
    onChange({ ...allow, levels: { ...allow.levels, [cat]: level } });
  };
  return (
    <div className="mt-3 space-y-1.5 border-t border-black/5 pt-3 dark:border-white/5">
      <div className="flex flex-wrap items-center gap-2 text-[0.82rem]">
        <span className="text-ink-soft dark:text-white/55">它能用的文件夹：</span>
        {allow.workDirs.map((d) => (
          <span key={d} className="flex items-center gap-1 rounded-lg bg-black/[0.04] px-2 py-0.5 font-mono dark:bg-white/10">
            {d}<button onClick={() => onChange({ ...allow, workDirs: allow.workDirs.filter((x) => x !== d) })} aria-label={`移除 ${d}`}><X size={12} /></button>
          </span>
        ))}
        <Button size="sm" variant="soft" onClick={async () => {
          let dir: string | null = null;
          if (inTauri) {
            const { open: pick } = await import('@tauri-apps/plugin-dialog');
            const r = await pick({ directory: true, multiple: false, title: '选一个让它用的文件夹' });
            dir = typeof r === 'string' ? r : null;
          } else {
            dir = await ask({ title: '添加文件夹', ok: '添加', input: { label: '文件夹路径', placeholder: 'D:\\共享', required: true } });
          }
          if (dir && !allow.workDirs.includes(dir)) onChange({ ...allow, workDirs: [...allow.workDirs, dir] });
        }}><Plus size={14} /> 加文件夹</Button>
      </div>
      {REMOTE_CATEGORIES.map((cat) => (
        <div key={cat} role="group" aria-label={`远程 ${CATEGORY_LABEL[cat].name}`} className="flex flex-wrap items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
          <div className="min-w-0 flex-1">
            <div className="text-[0.9rem] font-medium">{CATEGORY_LABEL[cat].name}</div>
            <div className="text-[0.75rem] text-ink-soft dark:text-white/45">{CATEGORY_LABEL[cat].hint}</div>
          </div>
          <Segmented id={`remote-${cat}`} value={allow.levels[cat] ?? 'deny'} onChange={(l) => void setLevel(cat, l)} options={[
            { value: 'allow', label: '允许' }, { value: 'ask', label: '问我' }, { value: 'deny', label: '不行' },
          ]} />
        </div>
      ))}
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
  const [testResult, setTestResult] = useState('');
  const closeToTray = usePrefs((p) => p.closeToTray);
  const setPrefs = usePrefs((p) => p.set);
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">通知与窗口</h2>
      <Row title="桌面通知" desc="窗口打开时不弹通知；最小化或收到托盘后提醒。测试通知会强制发送。">
        {on && <Button size="sm" variant="soft" onClick={async () => {
          const error = await notify('AM 通知测试', '能看到这条，就说明系统通知已显示。', { force: true });
          setTestResult(error ? '发送失败：' + error : '已向系统发送测试通知。');
        }}>测试通知</Button>}
        <Toggle label="桌面通知" checked={on} onChange={(v) => { setOn(v); localStorage.setItem('am-notify', v ? 'on' : 'off'); }} />
      </Row>
      {on && testResult && <p role="status" className="text-sm text-ink-soft">{testResult}</p>}
      {inTauri && (
        <Row title="点窗口的关闭按钮时" desc="收到托盘：AM 继续在后台收消息，在这台设备上运行的 AI 也保持在线；右下角托盘图标点一下打开，右键可以退出">
          <Segmented id="close-to-tray" value={closeToTray ? 'tray' : 'quit'} onChange={(x) => setPrefs({ closeToTray: x === 'tray' })} options={[
            { value: 'tray', label: '收到托盘' }, { value: 'quit', label: '直接退出' },
          ]} />
        </Row>
      )}
    </div>
  );
}

function About() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-[1.4rem] font-semibold">关于 AM</h2>
      <p className="mt-2 text-ink-soft dark:text-white/60">AM (AI Message) 是我和小克一起打造的新一代 AI 集成聊天工具。版本 {APP_VERSION}</p>
      <Button className="mt-5" variant="soft" onClick={() => openUrl('https://github.com/OzakiJUN/AM')}><ExternalLink size={16} /> GitHub</Button>
      <UpdateBox />
    </div>
  );
}

/** Updates (lib/update.ts): the newest verified release, check now, install. */
function UpdateBox() {
  const u = useUpdate();
  const newer = updateAvailable(u);
  const why = cannotUpdate();
  const auto = usePrefs((p) => p.updateCheck);
  const setPrefs = usePrefs((p) => p.set);
  const busy = u.status === 'checking' || u.status === 'downloading' || u.status === 'installing';
  return (
    <div className="mt-8" data-testid="update">
      <h3 className="text-[1.15rem] font-semibold">更新</h3>
      {why ? (
        <p className="mt-2 text-ink-soft dark:text-white/60">{why}</p>
      ) : (
        <>
          <Row title={newer ? `有新版本 ${u.latest!.version}` : u.latest ? '已经是最新版' : '还没检查过'} desc={
            (u.checkedAt ? `上次检查：${new Date(u.checkedAt).toLocaleString()}。` : '') + '新版本先验签（内置公钥）再换上：免安装版直接换掉 AM.exe（位置和名字不变），安装版运行安装程序。从 GitHub 下载，下不动时走镜像或你连着的服务器存的那份。'
          }>
            <Button size="sm" variant="soft" disabled={busy} onClick={() => checkGitHub()}>检查更新</Button>
            {newer && <Button size="sm" disabled={busy} onClick={() => installUpdate().catch(toastError)}>下载并安装</Button>}
          </Row>
          {u.status === 'downloading' && u.total > 0 && (
            <div className="py-2">
              <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                <motion.div className="h-full rounded-full bg-accent" animate={{ width: `${Math.round((u.done / u.total) * 100)}%` }} transition={spring} />
              </div>
              <div className="mt-1 text-[0.85rem] text-ink-soft">{(u.done / 1048576).toFixed(1)} / {(u.total / 1048576).toFixed(1)} MB</div>
            </div>
          )}
          {u.status === 'installing' && <p className="text-ink-soft">正在换成新版，AM 会自己关掉再打开…</p>}
          {u.status === 'error' && <p role="alert" className="text-rose-600">{u.error}</p>}
          <Row title="自动检查新版本" desc="打开 AM 时和之后每 6 小时查一次 GitHub；有新版在左边「设置」上提示">
            <Toggle label="自动检查新版本" checked={auto} onChange={(v) => setPrefs({ updateCheck: v })} />
          </Row>
          {newer && u.latest!.notes && (
            <div className="mt-4 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/5">
              <div className="mb-2 font-medium">{u.latest!.version} 更新了什么{u.latest!.date ? `（${u.latest!.date}）` : ''}</div>
              <pre className="max-h-80 overflow-y-auto font-sans text-[0.9rem] whitespace-pre-wrap text-ink-soft dark:text-white/70">{u.latest!.notes}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
