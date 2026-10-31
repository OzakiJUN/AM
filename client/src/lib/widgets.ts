// Profile boards (docs/design.md §7): up to 3 pages of 8 x 4 cells in
// landscape, 4 x 8 in portrait. Widgets are 1x1 to 4x4 and may sit anywhere
// (empty cells are fine). The portrait board follows the landscape one in
// reading order until it is arranged by hand. Pure functions, unit-tested.

export type Orientation = 'landscape' | 'portrait';
export const GRID: Record<Orientation, { cols: number; rows: number }> = {
  landscape: { cols: 8, rows: 4 },
  portrait: { cols: 4, rows: 8 },
};
export const MAX_PAGES = 3;
export const MAX_SIDE = 4;

export interface Cell {
  page: number;
  x: number;
  y: number;
}

export interface WidgetModel {
  id: string;
  kind: string;
  source: 'builtin' | 'workshop';
  w: number;
  h: number;
  land: Cell;
  /** Only when the layout's portrait board was arranged by hand. */
  port?: Cell;
  config: Record<string, unknown>;
  /** Server profile: who may change this widget's contents. */
  contentEditors: 'everyone' | 'admins';
  workshop?: { id: string; version: string; sha256: string };
  snapshotMediaId?: string;
}

export interface Background {
  kind: '' | 'color' | 'gradient' | 'image';
  value: string;
  mediaId?: string;
  blur: number;
  dim: number;
}

export interface LayoutModel {
  widgets: WidgetModel[];
  portraitCustom: boolean;
  background: Background;
  version: number;
}

export type Placements = Map<string, Cell>;

type Box = { w: number; h: number };

function overlaps(a: Cell & Box, b: Cell & Box) {
  return a.page === b.page && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Can a w x h widget sit at `cell` (inside the board, nothing else there)? `skip` = the widget being moved. */
export function fits(widgets: WidgetModel[], pl: Placements, o: Orientation, cell: Cell, w: number, h: number, skip?: string): boolean {
  const g = GRID[o];
  if (cell.page < 0 || cell.page >= MAX_PAGES || cell.x < 0 || cell.y < 0 || cell.x + w > g.cols || cell.y + h > g.rows) return false;
  return widgets.every((o2) => {
    if (o2.id === skip) return true;
    const c = pl.get(o2.id);
    return !c || !overlaps({ ...cell, w, h }, { ...c, w: o2.w, h: o2.h });
  });
}

/** First free spot for a w x h widget, trying `page` first, then the other pages. */
export function firstFree(widgets: WidgetModel[], pl: Placements, o: Orientation, w: number, h: number, page = 0): Cell | null {
  const g = GRID[o];
  const pages = [page, ...Array.from({ length: MAX_PAGES }, (_, i) => i).filter((p) => p !== page)];
  for (const p of pages) {
    for (let y = 0; y + h <= g.rows; y++) {
      for (let x = 0; x + w <= g.cols; x++) {
        if (fits(widgets, pl, o, { page: p, x, y }, w, h)) return { page: p, x, y };
      }
    }
  }
  return null;
}

const reading = (a: Cell, b: Cell) => a.page - b.page || a.y - b.y || a.x - b.x;

/**
 * Portrait board laid out from the landscape one: widgets in reading order
 * (page, row, column), each in the first free spot. May need more than
 * MAX_PAGES pages in rare cases; those extra pages are still shown.
 */
export function autoPortrait(widgets: WidgetModel[]): Placements {
  const g = GRID.portrait;
  const out: Placements = new Map();
  const placed: WidgetModel[] = [];
  for (const wd of [...widgets].sort((a, b) => reading(a.land, b.land))) {
    let spot: Cell | null = null;
    for (let p = 0; !spot; p++) {
      for (let y = 0; !spot && y + wd.h <= g.rows; y++) {
        for (let x = 0; !spot && x + wd.w <= g.cols; x++) {
          const c = { page: p, x, y };
          const free = placed.every((o) => !overlaps({ ...c, w: wd.w, h: wd.h }, { ...out.get(o.id)!, w: o.w, h: o.h }));
          if (free) spot = c;
        }
      }
      if (p > 20) break; // cannot happen with widgets of at most 4 x 4
    }
    if (spot) {
      out.set(wd.id, spot);
      placed.push(wd);
    }
  }
  return out;
}

/** Where every widget sits in an orientation. */
export function placements(l: LayoutModel, o: Orientation): Placements {
  if (o === 'landscape') return new Map(l.widgets.map((w) => [w.id, w.land]));
  if (l.portraitCustom) return new Map(l.widgets.filter((w) => w.port).map((w) => [w.id, w.port!]));
  return autoPortrait(l.widgets);
}

/** Pages that have widgets, in order (empty pages are not shown). */
export function usedPages(pl: Placements): number[] {
  return [...new Set([...pl.values()].map((c) => c.page))].sort((a, b) => a - b);
}

/** Fixes the portrait board as it looks now, so it can be edited by hand. */
export function freezePortrait(l: LayoutModel): LayoutModel {
  if (l.portraitCustom) return l;
  const pl = autoPortrait(l.widgets);
  // Widgets that only fit beyond the last page go to the first free spot or stay out.
  const widgets: WidgetModel[] = [];
  const kept: Placements = new Map();
  for (const w of l.widgets) {
    let c = pl.get(w.id);
    if (c && c.page >= MAX_PAGES) c = firstFree(widgets, kept, 'portrait', w.w, w.h) ?? undefined;
    if (!c) continue;
    kept.set(w.id, c);
    widgets.push({ ...w, port: c });
  }
  const byId = new Map(widgets.map((w) => [w.id, w]));
  return { ...l, portraitCustom: true, widgets: l.widgets.map((w) => byId.get(w.id) ?? { ...w, port: undefined }) };
}

/** Cell under a point, given the board's cell pitch (cell + gap) in px. */
export function cellAt(o: Orientation, page: number, px: number, py: number, pitch: number, w: number, h: number): Cell {
  const g = GRID[o];
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return { page, x: clamp(Math.round(px / pitch), g.cols - w), y: clamp(Math.round(py / pitch), g.rows - h) };
}
