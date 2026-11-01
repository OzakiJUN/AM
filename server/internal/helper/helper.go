package helper

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

// settingKey keeps the bot's account id in server_settings.
const settingKey = "helper_user_id"

// Call is one command someone sent.
type Call struct {
	User *store.User
	Conv *store.Conversation
	// Name is the command (or alias) as matched; Args the rest of the text.
	Name, Args string
	// Event is the message with the command.
	Event *amv1.Event
}

// DM: the command was sent in a DM with the bot (not in a channel).
func (c *Call) DM() bool { return c.Conv.Kind == int16(amv1.ConvKind_CONV_KIND_DM) }

// Command is something the bot answers.
type Command struct {
	Name    string
	Aliases []string
	// Group, Usage and Help are for 指令查询.
	Group, Usage, Help string
	Run                func(ctx context.Context, c *Call) error
}

// Inviter adds the bot to a channel on behalf of a member (conv.Service).
type Inviter interface {
	InviteMembers(ctx context.Context, me *store.User, convID int64, userIDs []int64) (*amv1.InviteMembersResponse, error)
}

// Service is the built-in bot.
type Service struct {
	st      *store.Store
	ms      *message.Service
	inv     Inviter
	log     *slog.Logger
	bot     *store.User
	maxText int
	timeout time.Duration

	mu   sync.RWMutex
	cmds []*Command
	busy map[int64]bool // users with a command running
}

// New makes sure the bot account exists (named name) and listens for commands.
func New(ctx context.Context, st *store.Store, ids *idgen.Generator, ms *message.Service, inv Inviter, name string, maxText int, log *slog.Logger) (*Service, error) {
	bot, err := ensureBot(ctx, st, ids, name)
	if err != nil {
		return nil, fmt.Errorf("helper bot: %w", err)
	}
	s := &Service{st: st, ms: ms, inv: inv, log: log, bot: bot, maxText: maxText, timeout: 10 * time.Minute, busy: map[int64]bool{}}
	ms.OnSent(s.hear)
	return s, nil
}

func ensureBot(ctx context.Context, st *store.Store, ids *idgen.Generator, name string) (*store.User, error) {
	set, err := st.ServerSettings(ctx)
	if err != nil {
		return nil, err
	}
	if id, _ := strconv.ParseInt(set[settingKey], 10, 64); id != 0 {
		u, err := st.GetUser(ctx, id)
		if err == nil {
			if u.DisplayName != name {
				if err := st.UpdateProfile(ctx, u.ID, name, u.AvatarMediaID, u.Avatar); err != nil {
					return nil, err
				}
				u.DisplayName = name
			}
			return u, nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	u := &store.User{ID: ids.Next(), DisplayName: name, AccountType: int16(amv1.AccountType_ACCOUNT_TYPE_BOT), CreatedAt: time.Now().UnixMilli()}
	for try := 0; ; try++ {
		u.Username = "helper_" + token(4)
		err = st.CreateUser(ctx, u)
		if err == nil || !store.IsUniqueViolation(err) || try == 4 {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	return u, st.SetServerSetting(ctx, settingKey, strconv.FormatInt(u.ID, 10))
}

func token(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Bot is the bot's account.
func (s *Service) Bot() *store.User { return s.bot }

// SetTimeout limits how long one command may run (tests).
func (s *Service) SetTimeout(d time.Duration) { s.timeout = d }

// Register adds commands (at startup).
func (s *Service) Register(cmds ...*Command) {
	s.mu.Lock()
	s.cmds = append(s.cmds, cmds...)
	s.mu.Unlock()
}

// Commands lists the registered commands.
func (s *Service) Commands() []*Command {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return slices.Clone(s.cmds)
}

// Names are all command names and aliases (ServerInfo.commands).
func (s *Service) Names() []string {
	var out []string
	for _, c := range s.Commands() {
		out = append(out, c.Name)
		out = append(out, c.Aliases...)
	}
	return out
}

func (s *Service) find(name string) *Command {
	for _, c := range s.Commands() {
		if c.Name == name || slices.Contains(c.Aliases, name) {
			return c
		}
	}
	return nil
}

// hear gets every message users send.
func (s *Service) hear(sender *store.User, ev *amv1.Event) {
	if sender.ID == s.bot.ID || ev.GetText() == nil {
		return
	}
	name, args, ok := Match(ev.GetText().GetText(), s.Names())
	if !ok {
		return
	}
	cmd := s.find(name)
	if cmd == nil {
		return
	}
	go s.run(sender, ev, cmd, name, args)
}

func (s *Service) run(sender *store.User, ev *amv1.Event, cmd *Command, name, args string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()
	conv, err := s.st.GetConv(ctx, ev.GetConvId())
	if err != nil || conv.Dissolved {
		return
	}
	switch amv1.ConvKind(conv.Kind) {
	case amv1.ConvKind_CONV_KIND_DM:
		ids, err := s.st.MemberIDs(ctx, []int64{conv.ID})
		if err != nil || !slices.Contains(ids[conv.ID], s.bot.ID) {
			return // a DM between two other people
		}
	case amv1.ConvKind_CONV_KIND_GROUP:
		if _, err := s.st.GetMember(ctx, conv.ID, s.bot.ID); errors.Is(err, store.ErrNotFound) {
			res, err := s.inv.InviteMembers(ctx, sender, conv.ID, []int64{s.bot.ID})
			if err != nil || len(res.GetAdded()) == 0 {
				s.log.Info("helper: could not join the channel", "conv", conv.ID, "err", err)
				return
			}
		} else if err != nil {
			return
		}
	default:
		return
	}
	s.mu.Lock()
	if s.busy[sender.ID] {
		s.mu.Unlock()
		_ = s.Reply(ctx, conv.ID, ev.GetEventId(), "上一条指令还没做完，等一下再发")
		return
	}
	s.busy[sender.ID] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.busy, sender.ID)
		s.mu.Unlock()
	}()
	if err := cmd.Run(ctx, &Call{User: sender, Conv: conv, Name: name, Args: args, Event: ev}); err != nil {
		msg := "出错了，等会儿再试"
		var ae *apperr.Error
		if errors.As(err, &ae) {
			msg = "出错了（" + ae.Code + "）"
		}
		var said Said
		if errors.As(err, &said) {
			msg = string(said)
		} else {
			s.log.Warn("helper: command failed", "command", cmd.Name, "err", err)
		}
		_ = s.Reply(ctx, conv.ID, ev.GetEventId(), msg)
	}
}

// Said is an error whose text is told to the person as is.
type Said string

func (e Said) Error() string { return string(e) }

// Say posts text in a conversation the bot is in, in several messages when
// it's long.
func (s *Service) Say(ctx context.Context, convID int64, text string) error {
	return s.Reply(ctx, convID, 0, text)
}

// Reply is Say with the first message replying to event replyTo (0 = none).
func (s *Service) Reply(ctx context.Context, convID, replyTo int64, text string) error {
	for i, part := range Split(text, s.maxText) {
		if part == "" {
			continue
		}
		msg := &amv1.TextMsg{Text: part}
		if i == 0 {
			msg.ReplyTo = replyTo
		}
		if _, err := s.ms.Send(ctx, s.bot, &amv1.SendRequest{ConvId: convID, ClientMsgId: "helper-" + token(12),
			Body: &amv1.SendRequest_Text{Text: msg}}, 0); err != nil {
			return err
		}
	}
	return nil
}
