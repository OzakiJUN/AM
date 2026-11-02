// Deterministic housekeeping of fishing widgets only. Existing unrelated content,
// positions and both board orientations stay intact.
import { firstFree, placements, type LayoutModel, type WidgetModel } from '../widgets.ts';
import { exhibitCapacity, ownFish, type FishingAccount } from '../fishing.ts';
export function arrangeFishingExhibits(layout: LayoutModel, account: FishingAccount, me: string): LayoutModel {
  let next: LayoutModel = { ...layout, widgets: layout.widgets.map((w) => ({ ...w, config: { ...w.config } })) };
  const fish = ownFish(account, me).sort((a, b) => b.value - a.value || b.length_m - a.length_m).map((f) => f.id);
  const cards = Object.keys(account.cards).filter((k) => account.cards[k] > 0).sort((a, b) => Number(b.split(':')[0]) - Number(a.split(':')[0]) || a.localeCompare(b));
  for (const [kind, all] of [['fishing_fish', fish], ['fishing_cards', cards], ['fishing_badges', account.badges.some((n) => n > 0) ? ['badge'] : []]] as const) {
    let widget = next.widgets.find((w) => w.kind === kind);
    if (!widget && all.length) {
      const land = firstFree(next.widgets, placements(next, 'landscape'), 'landscape', 2, 2);
      const port = next.portraitCustom ? firstFree(next.widgets, placements(next, 'portrait'), 'portrait', 2, 2) : undefined;
      if (!land || (next.portraitCustom && !port)) continue;
      widget = { id: `fish-auto-${kind.split('_')[1]}`, kind, source: 'builtin', w: 2, h: 2, land, port: port ?? undefined, config: {}, contentEditors: 'everyone' } as WidgetModel;
      next = { ...next, widgets: [...next.widgets, widget] };
    }
    if (widget) widget.config = kind === 'fishing_badges' ? {} : { ids: all.slice(0, exhibitCapacity(kind, widget.w, widget.h)), ...(kind === 'fishing_cards' ? { mode: 'cards' } : {}) };
  }
  return next;
}
