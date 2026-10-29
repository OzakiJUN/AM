// am-testclient is a command-line client for trying out the AM server
// before the real app exists. Type "help" after it starts.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
)

const defaultConfig = `# AM test client settings.
# Server address. Use https:// with the server's IP and port.
server = "https://127.0.0.1:8443"
# Certificate fingerprint printed by am-server at startup
# ("TLS self-signed certificate ... fingerprint=AB:CD:...").
# Leave empty only if the server runs with tls.mode = "off" (then use http://).
fingerprint = ""
`

type fileConfig struct {
	Server      string `toml:"server"`
	Fingerprint string `toml:"fingerprint"`
}

// profileState is saved per profile so you stay logged in and only fetch
// new messages next time.
type profileState struct {
	Token    string          `json:"token"`
	Username string          `json:"username"`
	Cursors  map[int64]int64 `json:"cursors"`
}

type app struct {
	cli         *amclient.Client
	profile     string
	statePath   string
	mu          sync.Mutex
	state       profileState
	conn        *amclient.Conn
	me          *amv1.User
	users       map[int64]*amv1.User
	convs       map[int64]*amv1.Conversation
	history     map[int64][]*amv1.Event
	current     int64
	stopReconn  chan struct{}
	reconnectOn bool
}

func main() {
	cfgPath := flag.String("config", "testclient.toml", "client config file")
	profile := flag.String("profile", "", "profile name (keeps separate logins, e.g. alice / bob)")
	flag.Parse()

	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		fatal(err)
	}
	in := bufio.NewReader(os.Stdin)
	if *profile == "" {
		fmt.Print("Profile name (e.g. alice): ")
		line, _ := in.ReadString('\n')
		*profile = strings.TrimSpace(line)
		if *profile == "" {
			*profile = "default"
		}
	}

	a := &app{
		profile:   *profile,
		statePath: "testclient_" + *profile + ".json",
		users:     map[int64]*amv1.User{},
		convs:     map[int64]*amv1.Conversation{},
		history:   map[int64][]*amv1.Event{},
	}
	if strings.HasPrefix(cfg.Server, "https://") {
		if cfg.Fingerprint == "" {
			fatal(fmt.Errorf("%s: fingerprint is empty; copy it from the am-server startup log", *cfgPath))
		}
		a.cli = amclient.New(cfg.Server, amclient.PinnedTLSConfig(cfg.Fingerprint))
	} else {
		a.cli = amclient.New(cfg.Server, nil)
	}
	a.loadState()
	fmt.Printf("AM test client - profile %q, server %s. Type \"help\" for commands.\n", a.profile, cfg.Server)

	if a.state.Token != "" {
		a.cli.Token = a.state.Token
		if err := a.connect(); err != nil {
			fmt.Println("Saved login did not work:", err)
		}
	} else {
		fmt.Println("Not logged in. Use: register <invite> <username> <password>   or   login <username> <password>")
	}

	for {
		a.prompt()
		line, err := in.ReadString('\n')
		if err != nil {
			break
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if line == "quit" || line == "exit" {
			break
		}
		if err := a.command(line); err != nil {
			fmt.Println("!", err)
		}
	}
	a.disconnect()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	fmt.Fprintln(os.Stderr, "Press Enter to exit.")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	os.Exit(1)
}

func loadConfig(path string) (*fileConfig, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, []byte(defaultConfig), 0o644); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("created %s - fill in server and fingerprint, then start again", path)
	}
	cfg := &fileConfig{}
	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, err
	}
	cfg.Server = strings.TrimRight(strings.TrimSpace(cfg.Server), "/")
	return cfg, nil
}

func (a *app) loadState() {
	a.state.Cursors = map[int64]int64{}
	if b, err := os.ReadFile(a.statePath); err == nil {
		_ = json.Unmarshal(b, &a.state)
		if a.state.Cursors == nil {
			a.state.Cursors = map[int64]int64{}
		}
	}
}

func (a *app) saveState() {
	b, _ := json.MarshalIndent(a.state, "", "  ")
	_ = os.WriteFile(a.statePath, b, 0o600)
}

func (a *app) prompt() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current != 0 {
		fmt.Printf("[%s] > ", a.convTitleLocked(a.current))
	} else {
		fmt.Print("> ")
	}
}

func ctx10() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// ---- commands ----

const help = `Commands:
  register <invite> <username> <password> [display name]   create an account
  login <username> <password>        log in
  logout                             forget this profile's login
  me                                 show my account
  invites | newinvite                list / create invite codes
  friends                            list friends and requests
  add <username>                     send a friend request
  accept <username>                  accept a friend request
  dm <username>                      open a DM with a friend (becomes current)
  convs                              list conversations with unread counts
  open <conv id>                     switch current conversation
  <any text>                         send to the current conversation
  send <text>                        same as above
  strike <event id>                  strike through one of your messages
  history [n]                        show the last n messages (default 20)
  sessions | kick <session id>       list / log out devices
  quit                               exit`

func (a *app) command(line string) error {
	cmd, rest, _ := strings.Cut(line, " ")
	rest = strings.TrimSpace(rest)
	args := strings.Fields(rest)
	ctx, cancel := ctx10()
	defer cancel()

	switch strings.ToLower(cmd) {
	case "help", "?":
		fmt.Println(help)
	case "register":
		if len(args) < 3 {
			return errors.New("usage: register <invite> <username> <password> [display name]")
		}
		display := strings.Join(args[3:], " ")
		resp, err := a.cli.Register(ctx, &amv1.RegisterRequest{InviteCode: args[0], Username: args[1],
			Password: args[2], DisplayName: display, DeviceName: "testclient-" + a.profile})
		if err != nil {
			return err
		}
		return a.loggedIn(resp)
	case "login":
		if len(args) != 2 {
			return errors.New("usage: login <username> <password>")
		}
		resp, err := a.cli.Login(ctx, &amv1.LoginRequest{Username: args[0], Password: args[1],
			DeviceName: "testclient-" + a.profile})
		if err != nil {
			return err
		}
		return a.loggedIn(resp)
	case "logout":
		a.disconnect()
		a.mu.Lock()
		a.state = profileState{Cursors: map[int64]int64{}}
		a.saveState()
		a.mu.Unlock()
		fmt.Println("Logged out.")
	case "me":
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.me == nil {
			return errors.New("not connected")
		}
		fmt.Printf("%s (@%s) id=%d\n", a.me.DisplayName, a.me.Username, a.me.Id)
	case "invites":
		resp, err := a.cli.ListInvites(ctx)
		if err != nil {
			return err
		}
		for _, inv := range resp.Invites {
			status := "unused"
			if inv.UsedBy != 0 {
				status = "used by " + inv.UsedByName
			}
			fmt.Printf("  %s  %s\n", inv.Code, status)
		}
		if resp.Remaining < 0 {
			fmt.Println("  You can create unlimited codes (admin).")
		} else {
			fmt.Printf("  You can create %d more.\n", resp.Remaining)
		}
	case "newinvite":
		inv, err := a.cli.CreateInvite(ctx)
		if err != nil {
			return err
		}
		fmt.Println("New invite code:", inv.Code)
	case "friends":
		resp, err := a.cli.ListFriends(ctx)
		if err != nil {
			return err
		}
		a.rememberUsers(resp.Friends, resp.Incoming, resp.Outgoing)
		printUsers("Friends", resp.Friends)
		printUsers("Requests to you (accept <username>)", resp.Incoming)
		printUsers("Your pending requests", resp.Outgoing)
	case "add":
		if len(args) != 1 {
			return errors.New("usage: add <username>")
		}
		if err := a.cli.RequestFriend(ctx, args[0]); err != nil {
			return err
		}
		fmt.Println("Friend request sent.")
	case "accept":
		if len(args) != 1 {
			return errors.New("usage: accept <username>")
		}
		id, err := a.findUser(ctx, args[0], true)
		if err != nil {
			return err
		}
		if err := a.cli.AcceptFriend(ctx, id); err != nil {
			return err
		}
		fmt.Println("Accepted.")
	case "dm":
		if len(args) != 1 {
			return errors.New("usage: dm <username>")
		}
		id, err := a.findUser(ctx, args[0], false)
		if err != nil {
			return err
		}
		c, err := a.cli.OpenDM(ctx, id)
		if err != nil {
			return err
		}
		a.mu.Lock()
		a.addConvLocked(c)
		a.current = c.Id
		a.mu.Unlock()
		fmt.Printf("Opened DM (conv %d). Type a message and press Enter.\n", c.Id)
	case "convs":
		a.listConvs()
	case "open":
		id, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return errors.New("usage: open <conv id>")
		}
		a.mu.Lock()
		c, ok := a.convs[id]
		if ok {
			a.current = id
			a.markReadLocked(id, c.LastSeq)
		}
		a.mu.Unlock()
		if !ok {
			return errors.New("no such conversation (see: convs)")
		}
		a.loadRecent(ctx, id, 50)
		a.showHistory(20)
	case "send":
		return a.sendText(ctx, rest)
	case "strike":
		id, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return errors.New("usage: strike <event id>   (event ids are shown in history as #seq/id)")
		}
		conn, conv := a.connAndCurrent()
		if conn == nil || conv == 0 {
			return errors.New("open a conversation first")
		}
		_, err = conn.Strike(ctx, conv, id)
		return err
	case "history":
		n := 20
		if len(args) == 1 {
			if v, err := strconv.Atoi(args[0]); err == nil && v > 0 {
				n = v
			}
		}
		a.showHistory(n)
	case "sessions":
		resp, err := a.cli.ListSessions(ctx)
		if err != nil {
			return err
		}
		for _, s := range resp.Sessions {
			mark := ""
			if s.Current {
				mark = " (this one)"
			}
			fmt.Printf("  %d  %s  last seen %s%s\n", s.Id, s.DeviceName, time.UnixMilli(s.LastSeen).Format("01-02 15:04"), mark)
		}
	case "kick":
		id, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			return errors.New("usage: kick <session id>")
		}
		return a.cli.RevokeSession(ctx, id)
	default:
		return a.sendText(ctx, line)
	}
	return nil
}

func printUsers(title string, list []*amv1.User) {
	fmt.Printf("%s:\n", title)
	if len(list) == 0 {
		fmt.Println("  (none)")
	}
	for _, u := range list {
		fmt.Printf("  %s (@%s) id=%d\n", u.DisplayName, u.Username, u.Id)
	}
}

func (a *app) loggedIn(resp *amv1.SessionResponse) error {
	a.disconnect()
	a.mu.Lock()
	if !strings.EqualFold(a.state.Username, resp.Me.Username) {
		a.state.Cursors = map[int64]int64{} // different account: start fresh
		a.history = map[int64][]*amv1.Event{}
	}
	a.state.Token = resp.Token
	a.state.Username = resp.Me.Username
	a.saveState()
	a.mu.Unlock()
	fmt.Printf("Logged in as %s (@%s).\n", resp.Me.DisplayName, resp.Me.Username)
	return a.connect()
}

// findUser resolves a username via the friend list (incoming requests too).
func (a *app) findUser(ctx context.Context, name string, includeIncoming bool) (int64, error) {
	resp, err := a.cli.ListFriends(ctx)
	if err != nil {
		return 0, err
	}
	a.rememberUsers(resp.Friends, resp.Incoming, resp.Outgoing)
	list := resp.Friends
	if includeIncoming {
		list = resp.Incoming
	}
	for _, u := range list {
		if strings.EqualFold(u.Username, name) {
			return u.Id, nil
		}
	}
	if includeIncoming {
		return 0, fmt.Errorf("no friend request from %s", name)
	}
	return 0, fmt.Errorf("%s is not your friend", name)
}

func (a *app) rememberUsers(lists ...[]*amv1.User) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, l := range lists {
		for _, u := range l {
			a.users[u.Id] = u
		}
	}
}

func (a *app) connAndCurrent() (*amclient.Conn, int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conn, a.current
}

func (a *app) sendText(ctx context.Context, text string) error {
	conn, conv := a.connAndCurrent()
	if conn == nil {
		return errors.New("not connected (login first)")
	}
	if conv == 0 {
		return errors.New("no conversation open - use: dm <username>  or  open <conv id>   (help for more)")
	}
	ev, err := conn.SendText(ctx, conv, text)
	if err != nil {
		return err
	}
	a.receive(ev, false)
	return nil
}

// ---- connection ----

func (a *app) connect() error {
	ctx, cancel := ctx10()
	defer cancel()
	conn, err := a.cli.Connect(ctx)
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.conn = conn
	a.me = conn.Auth.Me
	a.users[a.me.Id] = a.me
	for _, c := range conn.Auth.Conversations {
		a.addConvLocked(c)
	}
	if !a.reconnectOn {
		a.reconnectOn = true
		a.stopReconn = make(chan struct{})
		go a.watch()
	}
	a.mu.Unlock()
	go a.pushLoop(conn)
	if err := a.catchUp(conn); err != nil {
		fmt.Println("! sync failed:", err)
	}
	return nil
}

func (a *app) disconnect() {
	a.mu.Lock()
	if a.reconnectOn {
		close(a.stopReconn)
		a.reconnectOn = false
	}
	conn := a.conn
	a.conn = nil
	a.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
}

// watch reconnects with backoff whenever the connection drops.
func (a *app) watch() {
	a.mu.Lock()
	stop := a.stopReconn
	a.mu.Unlock()
	for {
		a.mu.Lock()
		conn := a.conn
		a.mu.Unlock()
		if conn == nil {
			return
		}
		select {
		case <-stop:
			return
		case <-conn.Done():
		}
		fmt.Println("\n* Disconnected, reconnecting...")
		delay := time.Second
		for {
			select {
			case <-stop:
				return
			case <-time.After(delay):
			}
			ctx, cancel := ctx10()
			nc, err := a.cli.Connect(ctx)
			cancel()
			if err == nil {
				a.mu.Lock()
				a.conn = nc
				for _, c := range nc.Auth.Conversations {
					a.addConvLocked(c)
				}
				a.mu.Unlock()
				go a.pushLoop(nc)
				if err := a.catchUp(nc); err != nil {
					fmt.Println("! sync failed:", err)
				}
				fmt.Println("* Reconnected.")
				a.prompt()
				break
			}
			if amclient.IsCode(err, "unauthorized") || amclient.IsCode(err, "banned") {
				fmt.Println("\n* Login is no longer valid (", err, "). Log in again.")
				a.mu.Lock()
				a.conn = nil
				a.reconnectOn = false
				a.mu.Unlock()
				return
			}
			if delay < 30*time.Second {
				delay *= 2
			}
		}
	}
}

// catchUp fetches everything after the saved cursors, page by page.
func (a *app) catchUp(conn *amclient.Conn) error {
	for {
		a.mu.Lock()
		cursors := map[int64]int64{}
		for id, c := range a.convs {
			if a.state.Cursors[id] < c.LastSeq {
				cursors[id] = a.state.Cursors[id]
			}
		}
		a.mu.Unlock()
		if len(cursors) == 0 {
			return nil
		}
		ctx, cancel := ctx10()
		resp, err := conn.Sync(ctx, cursors, 0)
		cancel()
		if err != nil {
			return err
		}
		for _, ev := range resp.Events {
			a.receive(ev, true)
		}
		if len(resp.HasMore) == 0 {
			// Mark conversations without events as caught up too.
			a.mu.Lock()
			for id := range cursors {
				if c := a.convs[id]; c != nil && a.state.Cursors[id] < c.LastSeq {
					a.state.Cursors[id] = c.LastSeq
				}
			}
			a.saveState()
			a.mu.Unlock()
			return nil
		}
	}
}

func (a *app) pushLoop(conn *amclient.Conn) {
	for f := range conn.Pushes {
		switch m := f.GetMsg().(type) {
		case *amv1.ServerFrame_Event:
			a.receive(m.Event.GetEvent(), false)
		case *amv1.ServerFrame_Conv:
			a.mu.Lock()
			a.addConvLocked(m.Conv.GetConversation())
			title := a.convTitleLocked(m.Conv.GetConversation().GetId())
			a.mu.Unlock()
			fmt.Printf("\n* Conversation available: %s (conv %d)\n", title, m.Conv.GetConversation().GetId())
			a.prompt()
		case *amv1.ServerFrame_Friend:
			u := m.Friend.GetUser()
			a.rememberUsers([]*amv1.User{u})
			if m.Friend.Kind == amv1.FriendPush_KIND_REQUEST_RECEIVED {
				fmt.Printf("\n* Friend request from %s (@%s) - type: accept %s\n", u.DisplayName, u.Username, u.Username)
			} else {
				fmt.Printf("\n* %s accepted your friend request - type: dm %s\n", u.DisplayName, u.Username)
			}
			a.prompt()
		}
	}
}

// receive stores an event and prints it if it belongs to the open conversation.
func (a *app) receive(ev *amv1.Event, fromSync bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, old := range a.history[ev.ConvId] {
		if old.EventId == ev.EventId {
			return // already have it
		}
	}
	a.history[ev.ConvId] = append(a.history[ev.ConvId], ev)
	if ev.Seq > a.state.Cursors[ev.ConvId] {
		a.state.Cursors[ev.ConvId] = ev.Seq
		a.saveState()
	}
	if c := a.convs[ev.ConvId]; c != nil && ev.Seq > c.LastSeq {
		c.LastSeq = ev.Seq
	}
	mine := a.me != nil && ev.SenderId == a.me.Id
	if ev.ConvId == a.current {
		a.markReadLocked(ev.ConvId, ev.Seq)
		if !mine || fromSync {
			fmt.Print("\r")
		}
		fmt.Println(a.formatLocked(ev))
		if !mine && !fromSync {
			fmt.Printf("[%s] > ", a.convTitleLocked(a.current))
		}
	} else if !mine && !fromSync {
		fmt.Printf("\n* New message in %s (conv %d) - type: open %d\n", a.convTitleLocked(ev.ConvId), ev.ConvId, ev.ConvId)
		a.promptLocked()
	}
}

// markReadLocked moves the read position of an open conversation forward.
func (a *app) markReadLocked(convID, seq int64) {
	c := a.convs[convID]
	if c == nil || a.conn == nil {
		return
	}
	if c.Self == nil {
		c.Self = &amv1.MemberState{}
	}
	if seq <= c.Self.ReadSeq {
		return
	}
	c.Self.ReadSeq = seq
	conn := a.conn
	go func() {
		ctx, cancel := ctx10()
		defer cancel()
		_ = conn.MarkRead(ctx, convID, seq)
	}()
}

func (a *app) promptLocked() {
	if a.current != 0 {
		fmt.Printf("[%s] > ", a.convTitleLocked(a.current))
	} else {
		fmt.Print("> ")
	}
}

func (a *app) addConvLocked(c *amv1.Conversation) {
	if old := a.convs[c.Id]; old != nil && old.LastSeq > c.LastSeq {
		c.LastSeq = old.LastSeq
	}
	a.convs[c.Id] = c
	for _, u := range c.Members {
		a.users[u.Id] = u
	}
}

func (a *app) convTitleLocked(id int64) string {
	c := a.convs[id]
	if c == nil {
		return fmt.Sprintf("conv %d", id)
	}
	if c.Kind == amv1.ConvKind_CONV_KIND_DM {
		for _, u := range c.Members {
			if a.me == nil || u.Id != a.me.Id {
				return "DM " + u.DisplayName
			}
		}
	}
	if c.Name != "" {
		return c.Name
	}
	return fmt.Sprintf("conv %d", id)
}

func (a *app) nameLocked(id int64) string {
	if u := a.users[id]; u != nil {
		label := u.DisplayName
		switch u.AccountType {
		case amv1.AccountType_ACCOUNT_TYPE_AI:
			label += " [AI, owner: " + u.OwnerDisplayName + "]"
		case amv1.AccountType_ACCOUNT_TYPE_BOT:
			label += " [Bot, owner: " + u.OwnerDisplayName + "]"
		}
		return label
	}
	return fmt.Sprintf("user %d", id)
}

// formatLocked renders one event. Struck messages show ~~like this~~.
func (a *app) formatLocked(ev *amv1.Event) string {
	ts := time.UnixMilli(ev.CreatedAt).Format("15:04")
	who := a.nameLocked(ev.SenderId)
	head := fmt.Sprintf("#%d/%d %s %s", ev.Seq, ev.EventId, ts, who)
	if ev.Redaction != nil {
		return fmt.Sprintf("%s: (deleted by %s: %s)", head, a.nameLocked(ev.Redaction.DeletedBy), ev.Redaction.Reason)
	}
	switch b := ev.GetBody().(type) {
	case *amv1.Event_Text:
		text := b.Text.GetText()
		if a.isStruckLocked(ev) {
			return fmt.Sprintf("%s: ~~%s~~ (struck)", head, text)
		}
		return fmt.Sprintf("%s: %s", head, text)
	case *amv1.Event_Strike:
		return fmt.Sprintf("%s struck through message %d", head, b.Strike.GetTargetEventId())
	default:
		return fmt.Sprintf("%s: (unsupported message type)", head)
	}
}

func (a *app) isStruckLocked(target *amv1.Event) bool {
	for _, ev := range a.history[target.ConvId] {
		if s := ev.GetStrike(); s != nil && s.TargetEventId == target.EventId {
			return true
		}
	}
	return false
}

// loadRecent fetches the last n events of a conversation when this
// program has none in memory yet (history is not saved to disk).
func (a *app) loadRecent(ctx context.Context, convID int64, n int64) {
	a.mu.Lock()
	conn := a.conn
	c := a.convs[convID]
	have := len(a.history[convID])
	a.mu.Unlock()
	if conn == nil || c == nil || have > 0 || c.LastSeq == 0 {
		return
	}
	from := c.LastSeq - n
	if from < 0 {
		from = 0
	}
	resp, err := conn.Sync(ctx, map[int64]int64{convID: from}, int32(n))
	if err != nil {
		return
	}
	a.mu.Lock()
	for _, ev := range resp.Events {
		a.history[convID] = append(a.history[convID], ev)
	}
	a.mu.Unlock()
}

func (a *app) showHistory(n int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current == 0 {
		fmt.Println("No conversation open.")
		return
	}
	list := a.history[a.current]
	sort.Slice(list, func(i, j int) bool { return list[i].Seq < list[j].Seq })
	if len(list) > n {
		list = list[len(list)-n:]
	}
	if len(list) == 0 {
		fmt.Println("(no messages yet)")
	}
	for _, ev := range list {
		fmt.Println(a.formatLocked(ev))
	}
}

func (a *app) listConvs() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.convs) == 0 {
		fmt.Println("No conversations yet. Add a friend, then: dm <username>")
		return
	}
	ids := make([]int64, 0, len(a.convs))
	for id := range a.convs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		c := a.convs[id]
		unread := c.LastSeq - c.GetSelf().GetReadSeq()
		mark := ""
		if id == a.current {
			mark = "  <- current"
		}
		fmt.Printf("  %d  %s  (%d messages, %d unread)%s\n", id, a.convTitleLocked(id), c.LastSeq, unread, mark)
	}
}
