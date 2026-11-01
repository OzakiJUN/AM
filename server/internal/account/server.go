package account

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/internal/connectcode"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// ServerMeta describes this server to clients: name, version and how to
// reach it (for join codes). Set by the supervisor once the certificate is
// loaded; until then join codes are left empty.
type ServerMeta struct {
	Name        string
	Version     string
	DownloadURL string
	// Join is the address part of join codes (Invite empty), nil when the
	// server has no public address configured.
	Join *connectcode.Join
}

type serverMeta struct {
	mu sync.RWMutex
	m  ServerMeta
}

// SetServer updates the server description.
func (s *Service) SetServer(m ServerMeta) {
	s.meta.mu.Lock()
	s.meta.m = m
	s.meta.mu.Unlock()
}

func (s *Service) server() ServerMeta {
	s.meta.mu.RLock()
	defer s.meta.mu.RUnlock()
	return s.meta.m
}

// ServerInfo answers GET /api/v1/server.
func (s *Service) ServerInfo() *amv1.ServerInfo {
	m := s.server()
	return &amv1.ServerInfo{Name: m.Name, Version: m.Version, DownloadUrl: m.DownloadURL, Icon: s.iconURL(), InstanceId: s.instance}
}

// InstanceID is the random id of this server process.
func (s *Service) InstanceID() string { return s.instance }

// PublicAddress is server.public_address ("" when not set).
func (s *Service) PublicAddress() string {
	if j := s.server().Join; j != nil {
		return j.Address
	}
	return ""
}

func (s *Service) iconURL() string {
	if _, v := s.media.ServerIcon(); v != 0 {
		return fmt.Sprintf("/api/v1/server/icon?v=%d", v)
	}
	return ""
}

// ---- server profile ----

// Server profile settings, kept in the server_settings table.
const (
	settingDescription   = "profile.description"
	settingLayoutEditors = "profile.layout_editors" // "admins" | "everyone"
	settingWidgetContent = "profile.widget_content" // "1" = members may edit widget contents
	maxDescription       = 500
)

// ProfileSettings is what the admin panel edits on the server profile.
type ProfileSettings struct {
	Description string `json:"description"`
	// "admins" or "everyone": who may rearrange widgets.
	LayoutEditors string `json:"layout_editors"`
	// Members may change widget contents (each widget can then get its own rule).
	WidgetContentEditable bool `json:"widget_content_editable"`
}

// ProfileSettings returns the saved settings, with defaults for unset ones.
func (s *Service) ProfileSettings(ctx context.Context) (*ProfileSettings, error) {
	m, err := s.st.ServerSettings(ctx)
	if err != nil {
		return nil, err
	}
	p := &ProfileSettings{Description: m[settingDescription], LayoutEditors: m[settingLayoutEditors],
		WidgetContentEditable: m[settingWidgetContent] == "1"}
	if p.LayoutEditors != "everyone" {
		p.LayoutEditors = "admins"
	}
	return p, nil
}

// SetProfileSettings saves the server profile settings (admin panel).
func (s *Service) SetProfileSettings(ctx context.Context, actorID int64, p *ProfileSettings) error {
	desc := strings.TrimSpace(p.Description)
	if utf8.RuneCountInString(desc) > maxDescription || (p.LayoutEditors != "admins" && p.LayoutEditors != "everyone") {
		return apperr.ErrBadRequest
	}
	widget := "0"
	if p.WidgetContentEditable {
		widget = "1"
	}
	return s.st.InTx(ctx, func(q *store.Queries) error {
		for k, v := range map[string]string{settingDescription: desc, settingLayoutEditors: p.LayoutEditors, settingWidgetContent: widget} {
			if err := q.SetServerSetting(ctx, k, v); err != nil {
				return err
			}
		}
		return s.audit(ctx, q, actorID, "server_profile", 0, "")
	})
}

// ServerProfile answers GET /api/v1/server/profile. online is the number of
// people online (and not invisible).
func (s *Service) ServerProfile(ctx context.Context, online int) (*amv1.ServerProfile, error) {
	p, err := s.ProfileSettings(ctx)
	if err != nil {
		return nil, err
	}
	members, err := s.st.CountActiveUsers(ctx)
	if err != nil {
		return nil, err
	}
	editors := amv1.ProfileEditors_PROFILE_EDITORS_ADMINS
	if p.LayoutEditors == "everyone" {
		editors = amv1.ProfileEditors_PROFILE_EDITORS_EVERYONE
	}
	return &amv1.ServerProfile{
		Name: s.server().Name, Description: p.Description, Icon: s.iconURL(),
		MemberCount: int32(members), OnlineCount: int32(online),
		LayoutEditors: editors, WidgetContentEditable: p.WidgetContentEditable,
	}, nil
}

// JoinCode builds the join code (and QR URL) for an invite, or "" when the
// server's public address is unknown. invite "" gives a server code.
func (s *Service) JoinCode(invite string) (code, url string) {
	m := s.server()
	if m.Join == nil {
		return "", ""
	}
	j := *m.Join
	j.Invite = invite
	code, err := j.Encode()
	if err != nil {
		return "", ""
	}
	return code, connectcode.URL(m.DownloadURL, code)
}
