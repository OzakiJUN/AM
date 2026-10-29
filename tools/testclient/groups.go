package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

const downloadDir = "testclient_downloads"

func (a *app) setMe(u *amv1.User) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.me = u
	a.users[u.Id] = u
}

// uploadPath uploads a local file (path may be wrapped in quotes).
func (a *app) uploadPath(path string) (*amv1.MediaInfo, error) {
	path = strings.Trim(strings.TrimSpace(path), `"`)
	if path == "" {
		return nil, errors.New("give a file path")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute) // big files on slow links
	defer cancel()
	return a.cli.Upload(ctx, filepath.Base(path), f)
}

// save downloads the image or file of an event into testclient_downloads.
func (a *app) save(ctx context.Context, eventID int64) error {
	a.mu.Lock()
	var ev *amv1.Event
	for _, list := range a.history {
		for _, e := range list {
			if e.EventId == eventID {
				ev = e
			}
		}
	}
	a.mu.Unlock()
	if ev == nil {
		return errors.New("event not found in history (open the conversation first)")
	}
	var mediaID int64
	name := ""
	switch {
	case ev.GetImage() != nil:
		mediaID, name = ev.GetImage().GetMediaId(), fmt.Sprintf("image_%d", eventID)
	case ev.GetFile() != nil:
		mediaID, name = ev.GetFile().GetMediaId(), ev.GetFile().GetName()
	default:
		return errors.New("that event has no image or file")
	}
	data, mime, err := a.cli.Download(ctx, fmt.Sprintf("/api/v1/media/%d", mediaID))
	if err != nil {
		return err
	}
	if ev.GetImage() != nil {
		name += map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[mime]
	}
	if err := os.MkdirAll(downloadDir, 0o755); err != nil {
		return err
	}
	out := filepath.Join(downloadDir, filepath.Base(name))
	if err := os.WriteFile(out, data, 0o644); err != nil {
		return err
	}
	abs, _ := filepath.Abs(out)
	fmt.Println("Saved to", abs)
	return nil
}

// refreshConv reloads a conversation (member list, roles) from the server.
func (a *app) refreshConv(convID int64) {
	ctx, cancel := ctx10()
	defer cancel()
	c, err := a.cli.GetConversation(ctx, convID)
	if err != nil {
		return
	}
	a.mu.Lock()
	a.addConvLocked(c)
	a.mu.Unlock()
}

// memberByName finds a member of the current conversation by username.
func (a *app) memberByName(name string) (int64, int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current == 0 {
		return 0, 0, errors.New("open a group first")
	}
	c := a.convs[a.current]
	for _, u := range c.GetMembers() {
		if strings.EqualFold(u.Username, name) {
			return a.current, u.Id, nil
		}
	}
	return a.current, 0, fmt.Errorf("%s is not in this group", name)
}

func (a *app) currentConv() (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.current == 0 {
		return 0, errors.New("open a group first")
	}
	return a.current, nil
}

// groupCommand handles group commands; handled=false means "not a group command".
func (a *app) groupCommand(ctx context.Context, cmd, rest string, args []string) (bool, error) {
	switch cmd {
	case "group":
		if len(args) < 1 {
			return true, errors.New("usage: group <name> [username ...]")
		}
		var ids []int64
		for _, name := range args[1:] {
			id, err := a.findUser(ctx, name, false)
			if err != nil {
				return true, err
			}
			ids = append(ids, id)
		}
		c, err := a.cli.CreateGroup(ctx, args[0], ids...)
		if err != nil {
			return true, err
		}
		a.mu.Lock()
		a.addConvLocked(c)
		a.current = c.Id
		a.mu.Unlock()
		fmt.Printf("Created group %q (conv %d).\n", c.Name, c.Id)
	case "invite":
		conv, err := a.currentConv()
		if err != nil {
			return true, err
		}
		var ids []int64
		for _, name := range args {
			id, err := a.findUser(ctx, name, false)
			if err != nil {
				return true, err
			}
			ids = append(ids, id)
		}
		if len(ids) == 0 {
			return true, errors.New("usage: invite <username ...>")
		}
		resp, err := a.cli.InviteMembers(ctx, conv, ids...)
		if err != nil {
			return true, err
		}
		fmt.Printf("Added %d, waiting for approval %d.\n", len(resp.Added), len(resp.Requested))
	case "members":
		conv, err := a.currentConv()
		if err != nil {
			return true, err
		}
		a.refreshConv(conv)
		a.mu.Lock()
		c := a.convs[conv]
		for i, u := range c.GetMembers() {
			role := amv1.MemberRole_MEMBER_ROLE_MEMBER
			if i < len(c.MemberRoles) {
				role = c.MemberRoles[i]
			}
			fmt.Printf("  %-8s %s (@%s)\n", roleName(role), u.DisplayName, u.Username)
		}
		if c.GetNotice() != "" {
			fmt.Println("  Notice:", c.GetNotice())
		}
		a.mu.Unlock()
	case "kick", "admin", "unadmin", "transfer", "unmute", "approve", "reject", "mute":
		if len(args) < 1 {
			return true, fmt.Errorf("usage: %s <username>", cmd)
		}
		var conv, uid int64
		var err error
		if cmd == "approve" || cmd == "reject" {
			conv, err = a.currentConv()
			if err == nil {
				uid, err = a.requestByName(ctx, conv, args[0])
			}
		} else {
			conv, uid, err = a.memberByName(args[0])
		}
		if err != nil {
			return true, err
		}
		switch cmd {
		case "kick":
			err = a.cli.RemoveMember(ctx, conv, uid)
		case "admin", "unadmin":
			err = a.cli.SetAdmin(ctx, conv, uid, cmd == "admin")
		case "transfer":
			err = a.cli.TransferGroup(ctx, conv, uid)
		case "unmute":
			err = a.cli.Mute(ctx, conv, uid, 0)
		case "mute":
			if len(args) < 2 {
				return true, errors.New("usage: mute <username> <minutes>")
			}
			minutes, perr := strconv.ParseInt(args[1], 10, 64)
			if perr != nil || minutes <= 0 {
				return true, errors.New("usage: mute <username> <minutes>")
			}
			err = a.cli.Mute(ctx, conv, uid, minutes*60)
		case "approve", "reject":
			err = a.cli.DecideJoinRequest(ctx, conv, uid, cmd == "approve")
		}
		if err == nil {
			a.refreshConv(conv)
			fmt.Println("Done.")
		}
		return true, err
	case "leave", "dissolve":
		conv, err := a.currentConv()
		if err != nil {
			return true, err
		}
		if cmd == "leave" {
			a.mu.Lock()
			me := a.me.GetId()
			a.mu.Unlock()
			return true, a.cli.RemoveMember(ctx, conv, me)
		}
		return true, a.cli.DissolveGroup(ctx, conv)
	case "rename", "notice", "approval":
		conv, err := a.currentConv()
		if err != nil {
			return true, err
		}
		req := &amv1.UpdateGroupRequest{}
		switch cmd {
		case "rename":
			req.Name = &rest
		case "notice":
			req.Notice = &rest
		case "approval":
			on := strings.EqualFold(rest, "on")
			if !on && !strings.EqualFold(rest, "off") {
				return true, errors.New("usage: approval on|off")
			}
			req.JoinApproval = &on
		}
		c, err := a.cli.UpdateGroup(ctx, conv, req)
		if err != nil {
			return true, err
		}
		a.mu.Lock()
		a.addConvLocked(c)
		a.mu.Unlock()
		fmt.Println("Updated.")
	case "requests":
		conv, err := a.currentConv()
		if err != nil {
			return true, err
		}
		resp, err := a.cli.ListJoinRequests(ctx, conv)
		if err != nil {
			return true, err
		}
		if len(resp.Requests) == 0 {
			fmt.Println("  (no pending requests)")
		}
		for _, r := range resp.Requests {
			fmt.Printf("  %s (@%s), invited by %s\n", r.User.DisplayName, r.User.Username, r.Inviter.DisplayName)
		}
	default:
		return false, nil
	}
	return true, nil
}

func (a *app) requestByName(ctx context.Context, conv int64, name string) (int64, error) {
	resp, err := a.cli.ListJoinRequests(ctx, conv)
	if err != nil {
		return 0, err
	}
	for _, r := range resp.Requests {
		if strings.EqualFold(r.User.Username, name) {
			return r.User.Id, nil
		}
	}
	return 0, fmt.Errorf("no pending request for %s", name)
}
