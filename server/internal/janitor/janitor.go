// Package janitor runs periodic cleanup: expired evidence, old login
// records and unused media files.
package janitor

import (
	"context"
	"log/slog"
	"time"

	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

const interval = time.Hour

type Janitor struct {
	st        *store.Store
	media     *media.Service
	retention config.Retention
	log       *slog.Logger
	now       func() time.Time
}

func New(st *store.Store, md *media.Service, retention config.Retention, log *slog.Logger) *Janitor {
	return &Janitor{st: st, media: md, retention: retention, log: log, now: time.Now}
}

// Run cleans up once right away, then every hour until ctx ends.
func (j *Janitor) Run(ctx context.Context) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		j.RunOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (j *Janitor) RunOnce(ctx context.Context) {
	now := j.now()
	if n, err := j.st.PurgeEvidence(ctx, now.UnixMilli()); err != nil {
		j.log.Error("purge evidence", "err", err)
	} else if n > 0 {
		j.log.Info("purged expired evidence", "rows", n)
	}
	before := now.Add(-time.Duration(j.retention.LoginRecordDays) * 24 * time.Hour).UnixMilli()
	if n, err := j.st.PurgeLoginRecords(ctx, before); err != nil {
		j.log.Error("purge login records", "err", err)
	} else if n > 0 {
		j.log.Info("purged old login records", "rows", n)
	}
	if n, err := j.media.GC(ctx); err != nil {
		j.log.Error("media cleanup", "err", err)
	} else if n > 0 {
		j.log.Info("removed unused media", "items", n)
	}
}
