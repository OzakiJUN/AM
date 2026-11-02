package profile

import (
	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/store"
	"testing"
)

func TestFishingWidgetLimits(t *testing.T) {
	w := &amv1.Widget{Id: "fish", Kind: "fishing_fish", Source: amv1.WidgetSource_WIDGET_SOURCE_BUILTIN, W: 2, H: 2, Landscape: &amv1.Cell{}, Config: `{"ids":["f001:min","f002:max"]}`}
	layout := &amv1.ProfileLayout{Widgets: []*amv1.Widget{w}}
	if _, _, err := validate(layout, store.ProfileUser); err != nil {
		t.Fatal(err)
	}
	w.Config = `{"ids":["f001:min","f002:max","f003:min"]}`
	if _, _, err := validate(layout, store.ProfileUser); err == nil {
		t.Fatal("more than area/2 fish accepted")
	}
	w.Kind = "fishing_cards"
	w.Config = `{"ids":["0:f001","1:f002","2:f003","3:f004"]}`
	if _, _, err := validate(layout, store.ProfileUser); err != nil {
		t.Fatal(err)
	}
	if _, _, err := validate(layout, store.ProfileServer); err == nil {
		t.Fatal("fishing widget on server profile")
	}
	w.Config = `{"ids":["0:f001","0:f001"]}`
	if _, _, err := validate(layout, store.ProfileUser); err == nil {
		t.Fatal("duplicate display card")
	}
}
