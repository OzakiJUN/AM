package game

import (
	"context"
	crand "crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
	"google.golang.org/protobuf/proto"
)

//go:embed fishing_rules.json
var fishingDefaults []byte

type FishSpecies struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Rarity      int     `json:"rarity"`
	Average     float64 `json:"average_m"`
	Value       Money   `json:"base_value"`
	Colour      string  `json:"colour"`
	Shape       string  `json:"shape"`
	Motif       int     `json:"motif"`
	Description string  `json:"description"`
}
type FishingRules struct {
	Version          int           `json:"version"`
	WaitMin          int           `json:"wait_min_seconds"`
	WaitMax          int           `json:"wait_max_seconds"`
	Bite             int           `json:"bite_seconds"`
	StartCoins       Money         `json:"start_coins"`
	PackPrice        Money         `json:"pack_price"`
	InventoryLimit   int           `json:"inventory_limit"`
	PackLimit        int           `json:"pack_limit"`
	FishWeights      []int         `json:"fish_weights"`
	LengthSigma      float64       `json:"length_sigma"`
	LengthValueScale float64       `json:"length_value_scale"`
	WorkerMS         int           `json:"worker_ms"`
	CatchupBatch     int           `json:"catchup_batch"`
	AutoStealDelay   int           `json:"auto_steal_delay_ms"`
	WardBlock        []int         `json:"ward_block_percent"`
	GlovePierce      []int         `json:"glove_pierce_percent"`
	CardWeights      []int         `json:"card_weights"`
	LootWeights      []int         `json:"loot_weights"`
	MoneyMin         int           `json:"money_min"`
	MoneyMax         int           `json:"money_max"`
	ToolPrices       []Money       `json:"tool_prices"`
	Speed            []int         `json:"speed_percent"`
	AutoCD           []int         `json:"auto_cd_seconds,omitempty"` // legacy custom rules; no longer used
	DoubleChance     []int         `json:"double_fish_percent"`
	Value            []int         `json:"value_percent"`
	StealBaseCD      int           `json:"steal_base_cd_seconds"`
	StealCount       []int         `json:"steal_fish_count"`
	StealReduction   []int         `json:"steal_cd_reduction_percent"`
	StealValue       []int         `json:"steal_value_percent"`
	StealCD          []int         `json:"steal_cd_seconds"`
	StealChance      []int         `json:"steal_percent"`
	WardCD           []int         `json:"ward_cd_seconds"`
	Catalog          []FishSpecies `json:"catalog"`
}

func DefaultFishingRules() *FishingRules {
	var r FishingRules
	_ = json.Unmarshal(fishingDefaults, &r)
	return &r
}
func (s *Service) LoadFishingRules(file string) error {
	if file == "" {
		return s.fishing.validate()
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var r FishingRules
	if err = json.Unmarshal(b, &r); err != nil {
		return err
	}
	if err = r.validate(); err != nil {
		return fmt.Errorf("fishing rules: %w", err)
	}
	s.fishing = &r
	return nil
}
func (r *FishingRules) validate() error {
	// Old rule files inherit the new perk without changing saved tool IDs.
	if r.DoubleChance == nil {
		r.DoubleChance = []int{10, 20, 30, 40, 50}
	}
	if len(r.DoubleChance) != 5 {
		return errors.New("invalid double fish chances")
	}
	for _, n := range r.DoubleChance {
		if n < 0 || n > 100 {
			return errors.New("invalid double fish chance")
		}
	}
	if r.StealBaseCD == 0 {
		r.StealBaseCD = 120
	}
	if r.StealCount == nil {
		r.StealCount = []int{1, 2, 3, 4, 5}
	}
	if r.StealReduction == nil {
		r.StealReduction = []int{10, 25, 40, 60, 80}
	}
	if r.StealValue == nil {
		r.StealValue = []int{15, 30, 55, 90, 150}
	}
	if r.StealBaseCD < 1 || r.StealBaseCD > 86400 {
		return errors.New("invalid base theft cooldown")
	}
	for _, setting := range []struct {
		values []int
		lo, hi int
	}{{r.StealCount, 1, 100}, {r.StealReduction, 0, 90}, {r.StealValue, 0, 1000}} {
		if len(setting.values) != 5 {
			return errors.New("invalid glove tiers")
		}
		for _, n := range setting.values {
			if n < setting.lo || n > setting.hi {
				return errors.New("invalid glove effect")
			}
		}
	}
	bad := func() error { return errors.New("invalid fishing balance or catalogue") }
	if r.Version != 2 || r.WaitMin < 1 || r.WaitMax < r.WaitMin || r.WaitMax > 3600 || r.Bite < 1 || r.Bite > 3600 || r.StartCoins < 0 || r.StartCoins > 1e9 || r.PackPrice < 1 || r.PackPrice > 1e9 || r.InventoryLimit < 1 || r.InventoryLimit > 10000 || r.PackLimit < 1 || r.PackLimit > 10000 || r.MoneyMin < 1 || r.MoneyMax < r.MoneyMin || r.MoneyMax > 1e6 || len(r.Catalog) != 100 {
		return bad()
	}
	for _, v := range [][]int{r.Speed, r.Value, r.StealCD, r.StealChance, r.WardCD} {
		if len(v) != 5 {
			return bad()
		}
		for _, n := range v {
			if n < 1 || n > 100000 {
				return bad()
			}
		}
	}
	if len(r.LootWeights) != 4 || len(r.ToolPrices) != 5 {
		return bad()
	}
	for _, w := range [][]int{r.FishWeights, r.CardWeights, r.LootWeights} {
		if len(w) != 5 && len(w) != 4 {
			return bad()
		}
		sum := 0
		for _, n := range w {
			if n < 0 || n > 100000 {
				return bad()
			}
			sum += n
		}
		if sum == 0 {
			return bad()
		}
	}
	if len(r.FishWeights) != 5 || len(r.CardWeights) != 5 {
		return bad()
	}
	for i := 0; i < 5; i++ {
		if r.ToolPrices[i] < 1 || r.ToolPrices[i] > 1e9 || r.Speed[i] > 90 || r.StealChance[i] > 100 {
			return bad()
		}
	}
	if r.LengthSigma <= 0 || r.LengthSigma > 2 || r.LengthValueScale <= 0 || r.LengthValueScale > 1000 || r.WorkerMS < 100 || r.WorkerMS > 60000 || r.CatchupBatch < 1 || r.CatchupBatch > 10000 || r.AutoStealDelay < 1 || len(r.WardBlock) != 5 || len(r.GlovePierce) != 5 {
		return bad()
	}
	for i := 0; i < 5; i++ {
		if r.WardBlock[i] < 0 || r.WardBlock[i] > 100 || r.GlovePierce[i] < 0 || r.GlovePierce[i] > 100 {
			return bad()
		}
	}
	seen := map[string]bool{}
	counts := [5]int{}
	for _, f := range r.Catalog {
		if seen[f.ID] || len(f.ID) > 20 || f.ID == "" || f.Name == "" || len(f.Name) > 100 || f.Rarity < 0 || f.Rarity > 4 || f.Average <= 0 || f.Average > 1e6 || f.Value < 1 || f.Value > 1e9 {
			return bad()
		}
		seen[f.ID] = true
		counts[f.Rarity]++
	}
	for _, n := range counts {
		if n == 0 {
			return bad()
		}
	}
	return nil
}
func (s *Service) FishingRules() *amv1.FishingData {
	b, _ := json.Marshal(s.fishing)
	return &amv1.FishingData{StateJson: string(b)}
}

type CaughtFish struct {
	BaseValue  Money   `json:"base_value,omitempty"`
	AcquiredAt int64   `json:"acquired_at,omitempty"`
	StealBonus int     `json:"steal_bonus_percent,omitempty"`
	Average    float64 `json:"average_m"`
	OwnerKey   string  `json:"owner_key"`
	ID         string  `json:"id"`
	Species    string  `json:"species"`
	Length     float64 `json:"length_m"`
	Value      Money   `json:"value"`
	By         string  `json:"caught_by"`
	At         int64   `json:"at"`
}
type FishingAccount struct {
	LocalSlot  string `json:"local_slot"`
	TransferTo string `json:"transfer_to"`
	Identity   string `json:"identity"`
	Revision   uint64 `json:"revision"`
	Frozen     bool   `json:"frozen"`
	TransferID string `json:"transfer_id"`

	Version int          `json:"version"`
	Coins   Money        `json:"coins"`
	Fish    []CaughtFish `json:"fish"`
	// Records are the smallest and largest self-caught specimens per species; selling doesn't erase them.
	Records  map[string]CaughtFish `json:"records"`
	Cards    map[string]int        `json:"cards"`
	Packs    int                   `json:"packs"`
	Tools    map[string]int        `json:"tools"`
	Equipped []string              `json:"equipped"`
	AutoAt   int64                 `json:"auto_at"`
	StealAt  int64                 `json:"steal_at"`
	WardAt   int64                 `json:"ward_at"`
	Room     string                `json:"room"`
	Last     string                `json:"last"`
	Opened   []string              `json:"opened"`
	Badges   [5]int                `json:"badges"`
}
type Angler struct {
	JoinedAt  int64 `json:"joined_at,omitempty"`
	User      int64 `json:"user_id,string"`
	BiteAt    int64 `json:"bite_at"`
	ExpiresAt int64 `json:"expires_at"`
}
type Pond struct {
	SettledAt  int64      `json:"settled_at,omitempty"`
	CatchingUp bool       `json:"catching_up"`
	Seats      [12]Angler `json:"seats"`
	Now        int64      `json:"now"`
}

func (r *FishingRules) newAccount() *FishingAccount {
	return &FishingAccount{Version: 2, Identity: fishingUUID(), LocalSlot: fishingUUID(), Coins: r.StartCoins, Fish: []CaughtFish{}, Records: map[string]CaughtFish{}, Cards: map[string]int{}, Tools: map[string]int{}, Equipped: []string{}}
}
func (s *Service) account(ctx context.Context, q *store.Queries, id int64) (*FishingAccount, error) {
	initial, _ := json.Marshal(s.fishing.newAccount())
	raw, err := q.FishingAccountForUpdate(ctx, id, string(initial))
	if err != nil {
		return nil, err
	}
	var a FishingAccount
	if err = json.Unmarshal([]byte(raw), &a); err != nil {
		return nil, err
	}
	if a.Version != 1 && a.Version != 2 {
		return nil, apperr.ErrBadRequest
	}
	upgraded := a.Version < 2 || a.LocalSlot == "" || a.Identity == ""
	if a.LocalSlot == "" {
		a.LocalSlot = fishingUUID()
	}
	if a.Identity == "" {
		a.Identity = fishingUUID()
	}
	if a.Cards == nil {
		a.Cards = map[string]int{}
	}
	if a.Tools == nil {
		a.Tools = map[string]int{}
	}
	if a.Records == nil {
		a.Records = map[string]CaughtFish{}
	}
	if a.Version < 2 {
		var legacy struct {
			Fish []struct {
				LengthCM float64 `json:"length_cm"`
			}
			Records map[string]struct {
				LengthCM float64 `json:"length_cm"`
			}
		}
		_ = json.Unmarshal([]byte(raw), &legacy)
		migrate := func(f CaughtFish, cm float64) CaughtFish {
			if f.Length == 0 {
				f.Length = math.Max(.01, math.Round(cm)/100)
			}
			if f.By == strconv.FormatInt(id, 10) {
				f.OwnerKey = a.Identity
			} else {
				f.OwnerKey = "stolen"
			}
			for _, species := range s.fishing.Catalog {
				if species.ID == f.Species {
					f.Average = species.Average / 100
					break
				}
			}
			return f
		}
		for i := range a.Fish {
			cm := 0.0
			if i < len(legacy.Fish) {
				cm = legacy.Fish[i].LengthCM
			}
			a.Fish[i] = migrate(a.Fish[i], cm)
		}
		for k, f := range a.Records {
			a.Records[k] = migrate(f, legacy.Records[k].LengthCM)
		}
		a.Version = 2
	}
	if upgraded {
		if err := saveAccount(ctx, q, id, &a); err != nil {
			return nil, err
		}
	}
	return &a, nil
}
func saveAccount(ctx context.Context, q *store.Queries, id int64, a *FishingAccount) error {
	a.Revision++
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return q.SaveFishingAccount(ctx, id, string(b))
}
func accountData(a *FishingAccount) *amv1.FishingData {
	b, _ := json.Marshal(a)
	return &amv1.FishingData{StateJson: string(b)}
}
func (s *Service) FishingAccount(ctx context.Context, me *store.User) (*amv1.FishingData, error) {
	var a *FishingAccount
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		var err error
		a, err = s.account(ctx, q, me.ID)
		if err != nil {
			return err
		}
		if a.Room != "" {
			roomID, _ := strconv.ParseInt(a.Room, 10, 64)
			g, e := q.GetGame(ctx, roomID)
			stale := errors.Is(e, store.ErrNotFound)
			if e != nil && !stale {
				return e
			}
			if e == nil {
				if g.Status == Ended {
					stale = true
				} else if e = member(ctx, q, g.ConvID, me.ID); e != nil {
					if !errors.Is(e, apperr.ErrNotMember) {
						return e
					}
					stale = true
				}
			}
			if stale {
				a.Room = ""
				return saveAccount(ctx, q, me.ID, a)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return accountData(a), nil
}
func (s *Service) FishingShowcase(ctx context.Context, user int64) (*amv1.FishingData, error) {
	a := s.fishing.newAccount()
	raw, err := s.st.FishingAccount(ctx, user)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), a); err != nil {
			return nil, err
		}
	}
	// A showcase is a live view of the owner's current inventory, never a
	// historical record. Selling a specimen immediately removes its public data.
	visible := map[string]CaughtFish{}
	_, layoutData, layoutErr := s.st.LatestLayout(ctx, store.ProfileUser, user)
	if layoutErr != nil && !errors.Is(layoutErr, store.ErrNotFound) {
		return nil, layoutErr
	}
	if layoutErr == nil {
		var layout amv1.ProfileLayout
		if err := proto.Unmarshal(layoutData, &layout); err != nil {
			return nil, err
		}
		wanted := map[string]bool{}
		for _, w := range layout.Widgets {
			if w.Kind != "fishing_fish" {
				continue
			}
			var cfg struct{ IDs []string }
			if json.Unmarshal([]byte(w.Config), &cfg) != nil {
				continue
			}
			for _, id := range cfg.IDs {
				wanted[id] = true
			}
		}
		for _, f := range a.Fish {
			if wanted[f.ID] && selfCaught(a, f, user) {
				visible[f.ID] = f
			}
		}
	}
	// No wallet, equipment, pending catch or private inventory leaves this endpoint.
	b, _ := json.Marshal(struct {
		Records map[string]CaughtFish `json:"records"`
		Cards   map[string]int        `json:"cards"`
		Badges  [5]int                `json:"badges"`
	}{visible, a.Cards, a.Badges})
	return &amv1.FishingData{StateJson: string(b)}, nil
}
func weighted(r *rand.Rand, w []int) int {
	sum := 0
	for _, n := range w {
		sum += n
	}
	x := r.Intn(sum)
	for i, n := range w {
		if x < n {
			return i
		}
		x -= n
	}
	return len(w) - 1
}
func (a *FishingAccount) quality(kind string) int {
	for _, k := range a.Equipped {
		if k == kind {
			return a.Tools[k]
		}
	}
	return 0
}
func (a *FishingAccount) addCard(key string) {
	a.Cards[key]++
	for rarity := 0; rarity < 5; rarity++ {
		n := 0
		for k, v := range a.Cards {
			if strings.HasPrefix(k, strconv.Itoa(rarity)+":") && v > 0 {
				n++
			}
		}
		a.Badges[rarity] = max(a.Badges[rarity], min(4, n/25))
	}
}
func (s *Service) card(a *FishingAccount) string {
	key := fmt.Sprintf("%d:%s", weighted(s.rnd, s.fishing.CardWeights), s.fishing.Catalog[s.rnd.Intn(len(s.fishing.Catalog))].ID)
	a.addCard(key)
	return key
}
func (s *Service) reward(a *FishingAccount, user int64, now int64, record bool) bool {
	r := s.fishing
	a.Opened = nil
	switch weighted(s.rnd, r.LootWeights) {
	case 1:
		n := Coins(float64(r.MoneyMin + s.rnd.Intn(r.MoneyMax-r.MoneyMin+1)))
		a.Coins += n
		a.Last = fmt.Sprintf("钓到钱袋，获得 %s 金币", n)
		return false
	case 2:
		key := s.card(a)
		a.Opened = []string{key}
		a.Last = "钓到一张鱼卡"
		return false
	case 3:
		if a.Packs < r.PackLimit {
			a.Packs++
			a.Last = "钓到一个卡包"
			return false
		}
	}
	return s.rewardFish(a, user, now, record)
}
func (s *Service) rewardFish(a *FishingAccount, user int64, now int64, record bool) bool {
	r := s.fishing
	if len(a.Fish) >= r.InventoryLimit {
		a.Last = "鱼篓满了，这条鱼放回了水里，请先卖鱼"
		return false
	}
	rarity := weighted(s.rnd, r.FishWeights)
	var pool []FishSpecies
	for _, f := range r.Catalog {
		if f.Rarity == rarity {
			pool = append(pool, f)
		}
	}
	f := pool[s.rnd.Intn(len(pool))]
	length := math.Max(.01, math.Round(f.Average*math.Exp(r.LengthSigma*s.rnd.NormFloat64()-r.LengthSigma*r.LengthSigma/2)*100)/100)
	value := fishPrice(f, length, r.LengthValueScale, a.quality("value"), r.Value)
	owner := "stolen"
	if record {
		owner = a.Identity
	}
	fish := CaughtFish{ID: fishingUUID(), Species: f.ID, Average: f.Average, Length: length, Value: value, OwnerKey: owner, By: strconv.FormatInt(user, 10), At: now}
	a.Fish = append(a.Fish, fish)
	if record {
		for _, extreme := range []string{"min", "max"} {
			key := f.ID + ":" + extreme
			prev, ok := a.Records[key]
			if !ok || (extreme == "min" && fish.Length < prev.Length) || (extreme == "max" && fish.Length > prev.Length) {
				a.Records[key] = fish
			}
		}
	}
	a.Last = fmt.Sprintf("钓到了 %s，%.2f m，价值 %s 金币", f.Name, fish.Length, fish.Value)
	return true
}

// Only the angler's own fish catch can trigger the second independent fish.
// Cards, packs, money bags and stolen catches never duplicate.
func (s *Service) landCatch(a *FishingAccount, user int64, now int64) {
	if !s.reward(a, user, now, true) {
		return
	}
	q := a.quality("auto")
	if q == 0 || s.rnd.Intn(100) >= s.fishing.DoubleChance[q-1] {
		return
	}
	first := a.Last
	if s.rewardFish(a, user, now, true) {
		a.Last = "双鱼竿生效！" + first + "；" + a.Last
	} else {
		a.Last = first + "；双鱼竿触发，但鱼篓已满，第二条放回水中"
	}
}
func (s *Service) cast(p *Angler, a *FishingAccount, now int64) {
	r := s.fishing
	wait := r.WaitMin + s.rnd.Intn(r.WaitMax-r.WaitMin+1)
	if q := a.quality("speed"); q > 0 {
		wait = max(r.WaitMin, wait*(100-r.Speed[q-1])/100)
	}
	p.BiteAt = now + int64(wait)*1000
	p.ExpiresAt = p.BiteAt // legacy field; catches now enter the basket immediately
}
func (s *Service) isPond(ctx context.Context, id int64) bool {
	g, err := s.st.GetGame(ctx, id)
	return err == nil && g.Kind == Fishing
}
func rebuildPond(st *State) {
	st.Players = nil
	for _, p := range st.Pond.Seats {
		if p.User > 0 {
			st.Players = append(st.Players, Player{ID: p.User})
		}
	}
}
func (s *Service) openPond(ctx context.Context, me *store.User, conv int64) (*amv1.Game, error) {
	now := time.Now().UnixMilli()
	st := &State{Kind: Fishing, Status: Playing, Turn: -1, Pond: &Pond{Now: now, SettledAt: now}, AutoApprove: true}
	g := &store.Game{ID: s.ids.Next(), ConvID: conv, Kind: Fishing, HostID: me.ID, Status: Playing, CreatedAt: now, UpdatedAt: now}
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		if err := member(ctx, q, conv, me.ID); err != nil {
			return err
		}
		n, err := q.CountActiveGames(ctx, conv)
		if err != nil {
			return err
		}
		if n >= s.max {
			return ErrGameLimit
		}
		a, err := s.account(ctx, q, me.ID)
		if err != nil {
			return err
		}
		if a.Room != "" || a.Frozen {
			return ErrGameState
		}
		a.Room = strconv.FormatInt(g.ID, 10)
		s.mu.Lock()
		st.Pond.Seats[0] = Angler{User: me.ID, JoinedAt: now}
		s.cast(&st.Pond.Seats[0], a, now)
		s.mu.Unlock()
		rebuildPond(st)
		b, _ := json.Marshal(st)
		g.State = string(b)
		if err = q.CreateGame(ctx, g); err != nil {
			return err
		}
		return saveAccount(ctx, q, me.ID, a)
	})
	if err != nil {
		return nil, err
	}
	s.broadcast(ctx, g, st)
	return view(g, st, me.ID), nil
}

// Lock game first, then all involved accounts in ascending order. This keeps steals,
// shop operations, two devices and different ponds from duplicating rewards.
func (s *Service) pondChange(ctx context.Context, me *store.User, id int64, action string, target int) (*amv1.Game, error) {
	var g *store.Game
	var st *State
	changed := false
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		var err error
		g, err = q.GetGameForUpdate(ctx, id)
		if err != nil {
			return err
		}
		if me.ID > 0 {
			if err = member(ctx, q, g.ConvID, me.ID); err != nil {
				return err
			}
		}
		st, err = load(g)
		if err != nil {
			return err
		}
		if st.Pond == nil {
			return ErrGameState
		}
		if st.Status == Ended {
			if action == "refresh" {
				return nil
			}
			return ErrGameState
		}
		var ids []int64
		if me.ID > 0 {
			ids = append(ids, me.ID)
		}
		for _, p := range st.Pond.Seats {
			if p.User > 0 && p.User != me.ID {
				ids = append(ids, p.User)
			}
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		accounts := map[int64]*FishingAccount{}
		originalAccounts := map[int64]string{}
		for _, u := range ids {
			a, err := s.account(ctx, q, u)
			if err != nil {
				return err
			}
			accounts[u] = a
			b, _ := json.Marshal(a)
			originalAccounts[u] = string(b)
		}
		now := time.Now().UnixMilli()
		s.mu.Lock()
		defer s.mu.Unlock()
		if st.Pond.SettledAt == 0 {
			st.Pond.SettledAt = g.UpdatedAt
			changed = true
		}
		for i := range st.Pond.Seats {
			if st.Pond.Seats[i].User != 0 && st.Pond.Seats[i].JoinedAt == 0 {
				st.Pond.Seats[i].JoinedAt = g.CreatedAt
				changed = true
			}
		}
		// Evict members that left, and stop copies frozen for client transfer.
		for i := range st.Pond.Seats {
			p := &st.Pond.Seats[i]
			if p.User == 0 {
				continue
			}
			a := accounts[p.User]
			e := member(ctx, q, g.ConvID, p.User)
			if e != nil && !errors.Is(e, apperr.ErrNotMember) {
				return e
			}
			if e != nil || a.Frozen {
				if a.Room == strconv.FormatInt(id, 10) {
					a.Room = ""
				}
				*p = Angler{}
				changed = true
			}
		}
		if s.settlePond(st, accounts, now) {
			changed = true
		}
		mine := -1
		for i, p := range st.Pond.Seats {
			if p.User == me.ID {
				mine = i
			}
		}
		if st.Pond.CatchingUp && action != "refresh" {
			return ErrGameState
		}
		a := accounts[me.ID]
		if a != nil && a.Frozen && action != "refresh" && action != "leave" && action != "end" {
			return ErrGameState
		}
		switch action {
		case "refresh":
		case "join", "sit":
			if mine >= 0 {
				if action == "sit" && target >= 0 && target < 12 && st.Pond.Seats[target].User == 0 {
					st.Pond.Seats[target] = st.Pond.Seats[mine]
					st.Pond.Seats[mine] = Angler{}
					changed = true
				}
				break
			}
			if a.Room != "" {
				return ErrGameState
			}
			if target < 0 {
				for i, p := range st.Pond.Seats {
					if p.User == 0 {
						target = i
						break
					}
				}
			}
			if target < 0 || target >= 12 || st.Pond.Seats[target].User != 0 {
				return ErrGameFull
			}
			a.Room = strconv.FormatInt(id, 10)
			st.Pond.Seats[target] = Angler{User: me.ID, JoinedAt: now}
			s.cast(&st.Pond.Seats[target], a, now)
			changed = true
		case "reel":
			// Compatibility with older clients: harvest is automatic.
			if mine < 0 {
				return apperr.ErrNoPermission
			}
		case "steal":
			if mine < 0 {
				return apperr.ErrNoPermission
			}
			quality := a.gloveQuality()
			if quality < 1 || a.StealAt > now || target < 0 || target >= 12 || target == mine {
				return ErrBadMove
			}
			p := &st.Pond.Seats[target]
			if p.User == 0 || len(a.Fish) >= s.fishing.InventoryLimit || !hasStealable(accounts[p.User], now) {
				return ErrBadMove
			}
			s.stealCatch(st, accounts, mine, target, now)
			changed = true
		case "leave":
			if mine < 0 {
				return apperr.ErrNoPermission
			}
			st.Pond.Seats[mine] = Angler{}
			a.Room = ""
			changed = true
		case "end":
			if me.ID != g.HostID {
				return apperr.ErrNoPermission
			}
			for _, v := range accounts {
				if v.Room == strconv.FormatInt(id, 10) {
					v.Room = ""
				}
			}
			st.Status = Ended
			st.Result = "closed"
			changed = true
		default:
			return apperr.ErrBadRequest
		}
		rebuildPond(st)
		st.Pond.Now = now
		if !changed {
			return nil
		}
		for _, u := range ids {
			b, _ := json.Marshal(accounts[u])
			if string(b) == originalAccounts[u] {
				continue
			}
			if err = saveAccount(ctx, q, u, accounts[u]); err != nil {
				return err
			}
		}
		b, _ := json.Marshal(st)
		g.State = string(b)
		g.Status = st.Status
		g.UpdatedAt = now
		return q.SaveGame(ctx, g)
	})
	if err != nil {
		return nil, err
	}
	if changed {
		s.broadcast(ctx, g, st)
	}
	return view(g, st, me.ID), nil
}

func (s *Service) FishingAction(ctx context.Context, me *store.User, req *amv1.FishingActionRequest) (*amv1.FishingData, error) {
	if len(req.RequestId) < 8 || len(req.RequestId) > 64 || len(req.FishIds) > 1000 {
		return nil, apperr.ErrBadRequest
	}
	current, err := s.FishingAccount(ctx, me)
	if err != nil {
		return nil, err
	}
	var before FishingAccount
	if err = json.Unmarshal([]byte(current.StateJson), &before); err != nil {
		return nil, err
	}
	if before.Room != "" {
		room, _ := strconv.ParseInt(before.Room, 10, 64)
		fresh, e := s.pondChange(ctx, me, room, "refresh", 0)
		if e != nil {
			return nil, e
		}
		var state State
		if e = json.Unmarshal([]byte(fresh.StateJson), &state); e != nil {
			return nil, e
		}
		if state.Pond != nil && state.Pond.CatchingUp {
			return nil, ErrGameState
		}
	}
	var out *FishingAccount
	fingerprint := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d\x00%q", req.Action, req.Item, req.Quality, req.FishIds)))
	hash := hex.EncodeToString(fingerprint[:])
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		a, err := s.account(ctx, q, me.ID)
		if err != nil {
			return err
		}
		out = a
		if a.Frozen {
			return ErrGameState
		}
		seen, err := q.FishingReceipt(ctx, me.ID, req.RequestId, hash)
		if errors.Is(err, store.ErrFishingRequestReuse) {
			return apperr.ErrBadRequest
		}
		if err != nil {
			return err
		}
		if seen {
			return nil
		}
		r := s.fishing
		a.Opened = nil
		switch req.Action {
		case "sell":
			wanted := map[string]bool{}
			for _, id := range req.FishIds {
				if wanted[id] {
					return apperr.ErrBadRequest
				}
				wanted[id] = true
			}
			if len(wanted) == 0 {
				return ErrBadMove
			}
			var keep []CaughtFish
			var coins Money
			for _, f := range a.Fish {
				if wanted[f.ID] {
					coins += f.Value
					delete(wanted, f.ID)
				} else {
					keep = append(keep, f)
				}
			}
			if len(wanted) > 0 {
				return ErrBadMove
			}
			a.Fish = keep
			a.Coins += coins
			a.Last = fmt.Sprintf("卖鱼获得 %s 金币", coins)
		case "buy_tool":
			if !toolKind(req.Item) || req.Quality < 1 || req.Quality > 5 || a.Tools[req.Item] >= int(req.Quality) {
				return ErrBadMove
			}
			price := r.ToolPrices[req.Quality-1]
			if a.Coins < price {
				return ErrBadMove
			}
			a.Coins -= price
			a.Tools[req.Item] = int(req.Quality)
			if gloveKind(req.Item) && a.quality(req.Item) > 0 {
				a.StealAt = max(a.StealAt, time.Now().UnixMilli())
			}
			a.Last = "工具购买成功"
		case "equip":
			if !toolKind(req.Item) || a.Tools[req.Item] == 0 {
				return ErrBadMove
			}
			for _, k := range a.Equipped {
				if k == req.Item {
					return nil
				}
			}
			if len(a.Equipped) >= 2 {
				return ErrBadMove
			}
			a.Equipped = append(a.Equipped, req.Item)
			if gloveKind(req.Item) {
				a.StealAt = max(a.StealAt, time.Now().UnixMilli())
			}
			a.Last = "已装备"
		case "unequip":
			var keep []string
			for _, k := range a.Equipped {
				if k != req.Item {
					keep = append(keep, k)
				}
			}
			a.Equipped = keep
			a.Last = "已卸下"
		case "buy_pack":
			if a.Coins < r.PackPrice || a.Packs >= r.PackLimit {
				return ErrBadMove
			}
			a.Coins -= r.PackPrice
			a.Packs++
			a.Last = "购买了一个卡包"
		case "open_pack":
			if a.Packs < 1 {
				return ErrBadMove
			}
			a.Packs--
			s.mu.Lock()
			for i := 0; i < 4; i++ {
				a.Opened = append(a.Opened, s.card(a))
			}
			s.mu.Unlock()
			a.Last = "打开卡包，获得四张卡（重复卡保留数量）"
		default:
			return apperr.ErrBadRequest
		}
		return saveAccount(ctx, q, me.ID, a)
	})
	if err != nil {
		return nil, err
	}
	return accountData(out), nil
}
func toolKind(k string) bool {
	return k == "speed" || k == "auto" || k == "value" || gloveKind(k) || k == "ward"
}

func (s *Service) FishingAccountUser(ctx context.Context, id int64) (*store.User, error) {
	return s.st.GetUser(ctx, id)
}

func fishingUUID() string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func selfCaught(a *FishingAccount, f CaughtFish, user int64) bool {
	return f.OwnerKey == a.Identity || (f.OwnerKey == "" && f.By == strconv.FormatInt(user, 10))
}
func fishPrice(f FishSpecies, length, scale float64, quality int, boost []int) Money {
	factor := 1 + scale*math.Pow(math.Log(length/f.Average), 2)
	if quality > 0 {
		factor *= 1 + float64(boost[quality-1])/100
	}
	return Money(math.Round(float64(f.Value) * factor))
}
