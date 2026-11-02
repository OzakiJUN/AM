// Package app wires all modules together. Used by cmd/am-server and by the
// end-to-end tests, so both run exactly the same server.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/conv"
	"github.com/OzakiJUN/am/server/internal/draw"
	"github.com/OzakiJUN/am/server/internal/game"
	"github.com/OzakiJUN/am/server/internal/gateway"
	"github.com/OzakiJUN/am/server/internal/helper"
	"github.com/OzakiJUN/am/server/internal/hosting"
	"github.com/OzakiJUN/am/server/internal/httpapi"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/janitor"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/museum"
	"github.com/OzakiJUN/am/server/internal/music"
	"github.com/OzakiJUN/am/server/internal/news"
	"github.com/OzakiJUN/am/server/internal/plugin"
	"github.com/OzakiJUN/am/server/internal/presence"
	"github.com/OzakiJUN/am/server/internal/profile"
	"github.com/OzakiJUN/am/server/internal/remote"
	"github.com/OzakiJUN/am/server/internal/sticker"
	"github.com/OzakiJUN/am/server/internal/store"
	"github.com/OzakiJUN/am/server/internal/toilet"
)

type App struct {
	Store   *store.Store
	Hub     *gateway.Hub
	Account *account.Service
	Conv    *conv.Service
	Media   *media.Service
	Profile *profile.Service
	// Stickers: collections and the shared library (the panel's 表情库 page).
	Stickers *sticker.Service
	// Plugins: AI plugins (nil when plugins.enabled = false).
	Plugins *plugin.Service
	// Hosting: AIs run on this server (nil when hosting.enabled = false).
	Hosting *hosting.Service
	// Museum: channel museums (votes are settled in the background).
	Museum *museum.Service
	// Helper: the built-in bot; News: 游戏资讯 (it posts as the bot).
	Helper  *helper.Service
	News    *news.Service
	Janitor *janitor.Janitor
	Handler http.Handler
}

// New opens the database, applies migrations and builds the HTTP handler.
func New(ctx context.Context, cfg *config.Config, log *slog.Logger) (*App, error) {
	st, err := store.Open(ctx, store.Options{
		Driver:     cfg.Database.Driver,
		SQLitePath: cfg.SQLitePath(),
		URL:        cfg.Database.URL,
		MaxConns:   cfg.Database.MaxConns,
	})
	if err != nil {
		return nil, err
	}
	applied, err := st.Migrate(ctx)
	if err != nil {
		st.Close()
		return nil, err
	}
	for _, m := range applied {
		log.Info("applied migration", "file", m, "database", st.Dialect().String())
	}

	ids := idgen.New(cfg.Server.NodeID)
	hub := gateway.NewHub(log)
	md, err := media.New(st, ids, cfg.Server.DataDir, cfg.Limits.MaxUploadMB, cfg.Media.BlockDistance)
	if err != nil {
		st.Close()
		return nil, err
	}
	acct := account.New(st, ids, cfg.Invites, hub, md)
	acct.SetAILimit(cfg.Limits.MaxAIPerUser)
	acct.SetDeviceLimits(cfg.Limits.MaxDevices, time.Duration(cfg.Limits.PairCodeMinutes)*time.Minute)
	// New messages also reach the AIs' plugins (the tap is connected once the host exists).
	tap := &plugin.Tap{Next: hub}
	ms := message.New(st, ids, tap, md, cfg.Limits, cfg.Retention)
	cs := conv.New(st, ids, hub, ms, md, cfg.Limits, cfg.Server.DefaultChannel, log)
	ps := presence.New(st, hub)
	acct.OnRegistered(cs.Welcome)
	acct.OnLeft(cs.LeaveAll)
	prof := profile.New(st, ids, acct, cs, md, cfg.Retention)

	sk := sticker.New(st, ids, md, sticker.Config{Max: cfg.Limits.MaxStickers, Library: cfg.Stickers.Library,
		DefaultPublic: cfg.Stickers.DefaultPublic, DedupeDistance: cfg.Stickers.DedupeDistance, EvidenceDays: cfg.Retention.EvidenceDays})
	sk.LinkWaiting(ctx, log)

	var plugins *plugin.Service
	if pc := cfg.Plugins; pc.Enabled {
		host, err := plugin.NewHost(plugin.Config{Enabled: true, Python: pc.Python, PipIndex: pc.PipIndex, CommandStart: pc.CommandStart,
			Dir: cfg.InDataDir("plugins"), Spawn: !pc.NoSpawn}, st, ms, cs, md, log)
		if err != nil {
			st.Close()
			return nil, err
		}
		tap.SetHost(host)
		plugins = plugin.NewService(st, ids, md, acct, host, plugin.Limits{MaxZip: int64(pc.MaxZipMB) << 20,
			MaxUnpacked: int64(pc.MaxUnpackedMB) << 20, MaxPerAI: pc.MaxPerAI}, log)
		// host.Sync() runs once the built-in bot is known (below): plugins run as it.
	}

	var hosted *hosting.Service
	if hc := cfg.Hosting; hc.Enabled {
		hosted, err = hosting.New(hosting.Config{Enabled: true, MaxPerUser: hc.MaxPerUser, ClientPath: hc.ClientPath,
			Dir: cfg.InDataDir("hosting"), Spawn: !hc.NoSpawn}, st, ids, acct, log)
		if err != nil {
			if plugins != nil {
				plugins.Host().Close()
			}
			st.Close()
			return nil, err
		}
		hosted.SetOnline(hub.IsOnline)
	}

	mus := museum.New(museum.Config{Enabled: cfg.Museum.Enabled, MinMembers: cfg.Museum.MinMembers, VoteMinutes: cfg.Museum.VoteMinutes}, st, ids, ms, log)
	go mus.Run()

	bot, err := helper.New(ctx, st, ids, ms, cs, cfg.Helper.Name, cfg.Limits.MaxTextLength, cfg.Helper.Autofix, log)
	if err != nil {
		mus.Close()
		if hosted != nil {
			hosted.Close()
		}
		if plugins != nil {
			plugins.Host().Close()
		}
		st.Close()
		return nil, err
	}
	hc := cfg.Helper
	bot.SetModel(helper.Model{URL: hc.AIURL, Key: hc.AIKey, Name: hc.AIModel, Proxy: hc.AIProxy})
	cs.SetHelper(bot.Bot().ID)
	ps.AlwaysOn(bot.Bot().ID)
	if plugins != nil {
		plugins.SetBot(bot.Bot().ID)
		if err := plugins.RetireAIPlugins(ctx); err != nil {
			log.Warn("plugins: retiring the AIs' plugins", "err", err)
		}
		plugins.Host().Sync()
		bot.SetExternal(func() []helper.Entry {
			var out []helper.Entry
			for _, c := range plugins.Commands(context.Background()) {
				out = append(out, helper.Entry{Name: c.Name, Group: "🧩 插件：" + c.Plugin, Usage: c.Name, Help: c.Usage})
			}
			return out
		})
	}
	if err := cs.HelperEverywhere(ctx); err != nil {
		log.Warn("helper: joining the channels", "err", err)
	}
	nc := cfg.News
	if nc.AIURL == "" { // 游戏资讯 uses the bot's model unless it has its own
		nc.AIURL, nc.AIKey, nc.AIModel, nc.AIProxy = hc.AIURL, hc.AIKey, hc.AIModel, hc.AIProxy
	}
	nw := news.New(news.Config{Enabled: nc.Enabled, AIURL: nc.AIURL, AIKey: nc.AIKey, AIModel: nc.AIModel, AIProxy: nc.AIProxy,
		Proxy: nc.Proxy, CommunityProxy: nc.CommunityProxy, CheckMinutes: nc.CheckMinutes, DailyTime: nc.DailyTime,
		WeeklyDay: nc.WeeklyDay, WeeklyTime: nc.WeeklyTime, XWeekly: nc.XWeekly, XAIKey: nc.XAIKey, XAIModel: nc.XAIModel,
		XAIProxy: nc.XAIProxy, WeeklyAnyone: nc.WeeklyAnyone, Sources: nc.Sources, PerSource: nc.PerSource,
		DigestTop: nc.DigestTop, SteamTop: nc.SteamTop, SteamPush: nc.SteamPush, SteamCC: nc.SteamCC, MaxPerConv: nc.MaxPerConv,
		Cookies: map[string]string{"weibo": nc.WeiboCookie, "tieba": nc.TiebaCookie, "nga": nc.NGACookie, "bili": nc.BiliCookie, "steam": nc.SteamCookie},
	}, st, bot, log)
	go nw.Run()
	toilet.New(st, ids, ms, bot, log)
	dc := cfg.Draw
	draw.New(draw.Config{Enabled: dc.Enabled, Token: dc.Token, Proxy: dc.Proxy, API: dc.API, DailyPerPerson: dc.DailyPerPerson, NsfwInDM: dc.NsfwInDM,
		Settings: draw.Settings{MaxCount: dc.MaxCount, Steps: dc.Steps, Scale: dc.Scale, Sampler: dc.Sampler, Strength: dc.Strength,
			VibeStrength: dc.VibeStrength, RefStrength: dc.RefStrength, RefFidelity: dc.RefFidelity, Model: dc.Model, V5Model: dc.V5Model,
			V5Native: dc.V5Native, Quality: dc.Quality, QualityV5: dc.QualityV5, Negative: dc.Negative, BlockWords: dc.BlockWords, AutoNsfw: dc.AutoNsfw},
	}, st, ms, md, bot, log)

	games := game.New(st, ids, hub, cfg.Limits.MaxGamesPerConv)
	if err := games.LoadFishingRules(cfg.Fishing.RulesFile); err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	api := httpapi.New(acct, cs, ms, md, ps, prof, sk,
		music.New(cfg.Media.Netease, cfg.Media.NeteaseAPI, md), games, cfg.Limits.LoginAttemptsPerMinute, cfg.Limits.MaxUploadMB, cfg.Stickers.SyncKBps, log)
	if plugins != nil {
		api.SetPlugins(plugins)
	}
	if hosted != nil {
		api.SetHosting(hosted)
	}
	api.SetMuseum(mus)
	api.SetHelper(bot)
	api.Register(mux)
	mux.Handle("GET /ws", gateway.New(hub, acct, cs, ms, ps, remote.New(st, hub), log))

	return &App{
		Store:    st,
		Hub:      hub,
		Account:  acct,
		Conv:     cs,
		Media:    md,
		Profile:  prof,
		Stickers: sk,
		Plugins:  plugins,
		Hosting:  hosted,
		Museum:   mus,
		Helper:   bot,
		News:     nw,
		Janitor:  janitor.New(st, md, cfg.Retention, log),
		Handler:  mux,
	}, nil
}

func (a *App) Close() {
	a.News.Close()
	a.Museum.Close()
	if a.Hosting != nil {
		a.Hosting.Close()
	}
	if a.Plugins != nil {
		a.Plugins.Host().Close()
	}
	a.Store.Close()
}
