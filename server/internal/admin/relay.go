package admin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/config"
)

// Changing the relay address (docs/design.md §3, 更换中转地址): the new
// address must reach this same server (checked by connecting to it), then
// it becomes server.public_address without a restart and every online
// client is told; clients switch once they can connect there with the same
// certificate. The old relay should stay up until no device uses it.

const previousKey = "previous_public_addresses"

// probe connects to addr and checks that it is this server: same
// certificate (when self-signed) and same process id.
func probe(ctx context.Context, addr string, plain bool, fp []byte, instance string) error {
	if host, port, err := net.SplitHostPort(addr); err != nil || host == "" || port == "" {
		return errors.New("地址要像 47.1.2.3:7000 或 example.com:8443 这样，带端口")
	}
	scheme := "https"
	if plain {
		scheme = "http"
	}
	tr := &http.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true, // checked below: our own certificate, or the process id
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(fp) == 0 || len(cs.PeerCertificates) == 0 {
				return nil
			}
			sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
			if !bytes.Equal(sum[:len(fp)], fp) {
				return errors.New("这个地址连到的不是本服务器（证书不一样）")
			}
			return nil
		},
	}}
	c := &http.Client{Transport: tr, Timeout: 8 * time.Second}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s://%s/api/v1/server", scheme, addr), nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("连不上这个地址：%v（新中转的 frp 配好了吗？）", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	info := &amv1.ServerInfo{}
	if resp.StatusCode != http.StatusOK || protojson.Unmarshal(body, info) != nil {
		return fmt.Errorf("这个地址上不是 AM 服务器（返回 %d）", resp.StatusCode)
	}
	if info.GetInstanceId() != instance {
		return errors.New("这个地址连到的是另一台 AM 服务器，不是本服务器")
	}
	return nil
}

func (h *handler) previous(ctx context.Context) []string {
	snap := h.rt.Snapshot()
	if snap.App == nil {
		return nil
	}
	m, err := snap.App.Store.ServerSettings(ctx)
	if err != nil {
		return nil
	}
	var list []string
	_ = json.Unmarshal([]byte(m[previousKey]), &list)
	return list
}

func (h *handler) getRelay(w http.ResponseWriter, r *http.Request) {
	snap := h.rt.Snapshot()
	if snap.App == nil || snap.Config == nil {
		writeErr(w, http.StatusServiceUnavailable, "not_running", "服务器没在运行")
		return
	}
	type row struct {
		Address string `json:"address"`
		Devices int    `json:"devices"`
	}
	var rows []row
	for addr, n := range snap.App.Hub.AddressCounts() {
		rows = append(rows, row{addr, n})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Devices > rows[j].Devices })
	writeJSON(w, map[string]any{"current": snap.Config.Server.PublicAddress, "previous": h.previous(r.Context()), "connections": rows})
}

func (h *handler) relayAddress(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req struct {
		Address string `json:"address"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return "", false
	}
	snap := h.rt.Snapshot()
	if snap.App == nil || snap.Config == nil {
		writeErr(w, http.StatusServiceUnavailable, "not_running", "服务器没在运行")
		return "", false
	}
	if err := probe(r.Context(), req.Address, snap.Config.TLS.Mode == "off", snap.Fingerprint, snap.App.Account.InstanceID()); err != nil {
		writeErr(w, http.StatusBadRequest, "relay_unreachable", err.Error())
		return "", false
	}
	return req.Address, true
}

func (h *handler) testRelay(w http.ResponseWriter, r *http.Request) {
	if _, ok2 := h.relayAddress(w, r); ok2 {
		writeJSON(w, ok())
	}
}

func (h *handler) moveRelay(w http.ResponseWriter, r *http.Request) {
	addr, ok2 := h.relayAddress(w, r)
	if !ok2 {
		return
	}
	snap := h.rt.Snapshot()
	old := snap.Config.Server.PublicAddress
	path := snap.ConfigPath
	text, err := os.ReadFile(path)
	if err != nil {
		h.fail(w, err)
		return
	}
	next, err := config.Apply(string(text), []config.Change{{Section: "server", Key: "public_address", Value: addr}})
	if err == nil {
		err = config.WriteFile(path, next)
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	if old != "" && old != addr {
		list := []string{old}
		for _, a := range h.previous(r.Context()) {
			if a != old && a != addr && len(list) < 5 {
				list = append(list, a)
			}
		}
		b, _ := json.Marshal(list)
		_ = snap.App.Store.SetServerSetting(r.Context(), previousKey, string(b))
	}
	h.rt.SetPublicAddress(addr)
	snap.App.Hub.Broadcast(&amv1.ServerFrame{Msg: &amv1.ServerFrame_ServerMoved{ServerMoved: &amv1.ServerMovedPush{Address: addr}}})
	h.log.Info("public address changed in admin panel", "from", old, "to", addr)
	writeJSON(w, ok())
}
