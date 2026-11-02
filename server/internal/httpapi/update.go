package httpapi

import (
	"net/http"
	"os"

	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// UpdateSource is the client installer this server keeps (update.Updater).
type UpdateSource interface {
	ClientVersion() string
	Client() (version string, raw, sig []byte, path string)
}

// SetUpdate lets clients download the kept installer (docs/release.md);
// set before the server starts serving.
func (a *API) SetUpdate(u UpdateSource) { a.update = u }

func (a *API) clientVersion() string {
	if a.update == nil {
		return ""
	}
	return a.update.ClientVersion()
}

// updateFile serves the kept release.json, its signature or the installer.
// The client verifies all of it with its built-in key, so the server is
// just a relay; logged-in users only (it is large).
func (a *API) updateFile(which string) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
		if a.update == nil {
			a.fail(w, apperr.ErrNotFound)
			return
		}
		_, raw, sig, path := a.update.Client()
		if path == "" {
			a.fail(w, apperr.ErrNotFound)
			return
		}
		switch which {
		case "manifest":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(raw)
		case "sig":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write(sig)
		default:
			f, err := os.Open(path)
			if err != nil {
				a.fail(w, apperr.ErrNotFound)
				return
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				a.fail(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			http.ServeContent(w, r, "AM-setup.exe", st.ModTime(), f)
		}
	}
}
