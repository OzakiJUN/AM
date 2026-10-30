package httpapi

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
	"github.com/OzakiJUN/am/server/internal/view"
)

func pathID(r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id, err == nil && id > 0
}

// ---- lookups ----

func (a *API) getConversation(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	c, err := a.conv.ConvView(r.Context(), id, me.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}

func (a *API) getUser(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	u, err := a.conv.UserViewByID(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, u)
}

// ---- profile ----

func (a *API) updateProfile(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.UpdateProfileRequest{}
	if !a.read(w, r, req) {
		return
	}
	u, err := a.acct.UpdateProfile(r.Context(), me, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.conv.UserView(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) setPresence(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.SetPresenceRequest{}
	if !a.read(w, r, req) {
		return
	}
	p, err := a.presence.Set(r.Context(), me, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, p)
}

func (a *API) leaveServer(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	if err := a.acct.Leave(r.Context(), me); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

// serverIcon serves the server's icon (public, like GET /api/v1/server).
func (a *API) serverIcon(w http.ResponseWriter, r *http.Request) {
	f, _ := a.media.ServerIcon()
	if f == nil {
		a.fail(w, media.ErrMediaMissing)
		return
	}
	w.Header().Set("Content-Type", f.Mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=86400") // the URL changes with the file
	http.ServeFile(w, r, f.Path)
}

func (a *API) serverProfile(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	p, err := a.acct.ServerProfile(r.Context(), a.presence.VisibleCount())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, p)
}

func (a *API) listLogins(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	resp, err := a.acct.ListLoginRecords(r.Context(), me.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

// ---- groups ----

func (a *API) createGroup(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.CreateGroupRequest{}
	if !a.read(w, r, req) {
		return
	}
	c, err := a.conv.CreateGroup(r.Context(), me, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}

func (a *API) updateGroup(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.UpdateGroupRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	c, err := a.conv.UpdateGroup(r.Context(), me, id, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}

func (a *API) dissolveGroup(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if err := a.conv.Dissolve(r.Context(), me, id); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) inviteMembers(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.InviteMembersRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	resp, err := a.conv.InviteMembers(r.Context(), me, id, req.GetUserIds())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) removeMember(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok1 := pathID(r, "id")
	uid, ok2 := pathID(r, "uid")
	if !ok1 || !ok2 {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if err := a.conv.RemoveMember(r.Context(), me, id, uid); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) setAdmin(admin bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok1 := pathID(r, "id")
		uid, ok2 := pathID(r, "uid")
		if !ok1 || !ok2 {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		if err := a.conv.SetAdmin(r.Context(), me, id, uid, admin); err != nil {
			a.fail(w, err)
			return
		}
		a.ok(w, &amv1.Empty{})
	}
}

func (a *API) transferGroup(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.TransferGroupRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	if err := a.conv.Transfer(r.Context(), me, id, req.GetUserId()); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) muteMember(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.MuteMemberRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	if err := a.conv.Mute(r.Context(), me, id, req); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) listJoinRequests(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	resp, err := a.conv.ListJoinRequests(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) decideJoin(approve bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok1 := pathID(r, "id")
		uid, ok2 := pathID(r, "uid")
		if !ok1 || !ok2 {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		if err := a.conv.DecideJoinRequest(r.Context(), me, id, uid, approve); err != nil {
			a.fail(w, err)
			return
		}
		a.ok(w, &amv1.Empty{})
	}
}

// ---- moderation ----

func (a *API) adminDelete(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.AdminDeleteRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	if err := a.msg.AdminDelete(r.Context(), me, id, req); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

// ---- media ----

func (a *API) upload(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	// Allow some room for multipart framing on top of the file itself.
	r.Body = http.MaxBytesReader(w, r.Body, a.maxUpload+(1<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			a.fail(w, apperr.ErrBadRequest) // no "file" field
			return
		}
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				a.fail(w, media.ErrTooLarge)
				return
			}
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		m, err := a.media.Upload(r.Context(), me.ID, part.FileName(), part)
		part.Close()
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				err = media.ErrTooLarge
			}
			a.fail(w, err)
			return
		}
		a.ok(w, view.Media(m))
		return
	}
}

func (a *API) download(thumb bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok := pathID(r, "id")
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		f, err := a.media.Open(r.Context(), me, id, thumb)
		if err != nil {
			a.fail(w, err)
			return
		}
		file, err := os.Open(f.Path)
		if err != nil {
			a.fail(w, media.ErrMediaMissing)
			return
		}
		defer file.Close()
		st, err := file.Stat()
		if err != nil {
			a.fail(w, err)
			return
		}
		h := w.Header()
		h.Set("Content-Type", f.Mime)
		h.Set("X-Content-Type-Options", "nosniff")
		// Uploaded files never run as a page on this origin.
		h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
		h.Set("Cache-Control", "private, max-age=31536000, immutable")
		if len(f.Mime) < 6 || f.Mime[:6] != "image/" {
			h.Set("Content-Disposition", "attachment"+media.ContentDisposition(f.Name)[len("inline"):])
		} else {
			h.Set("Content-Disposition", media.ContentDisposition(f.Name))
		}
		http.ServeContent(w, r, "", st.ModTime(), file)
	}
}
