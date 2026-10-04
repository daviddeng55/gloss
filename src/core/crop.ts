// Which part of the screen to send when asking: what you circled, or an area around the cursor.

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type CropOptions = {
  padding: number; // points added around a circled area
  fallbackW: number; // area around the cursor when nothing was circled
  fallbackH: number;
  minCircle: number; // a path smaller than this (points) in both directions isn't a circle
};

export const DEFAULT_CROP: CropOptions = { padding: 24, fallbackW: 900, fallbackH: 700, minCircle: 40 };

/** Keeps `r` inside `bounds`, shrinking it if it's bigger. */
function clamp(r: Rect, bounds: Rect): Rect {
  const w = Math.min(r.w, bounds.w);
  const h = Math.min(r.h, bounds.h);
  const x = Math.min(Math.max(r.x, bounds.x), bounds.x + bounds.w - w);
  const y = Math.min(Math.max(r.y, bounds.y), bounds.y + bounds.h - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** The crop for a cursor `path` (global points) on a display with `bounds`; `circled` says which rule applied. */
export function cropFor(path: Point[], cursor: Point, bounds: Rect, opts: CropOptions = DEFAULT_CROP): { rect: Rect; circled: boolean } {
  if (path.length >= 2) {
    const xs = path.map((p) => p.x);
    const ys = path.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    if (maxX - minX >= opts.minCircle || maxY - minY >= opts.minCircle) {
      const rect = { x: minX - opts.padding, y: minY - opts.padding, w: maxX - minX + 2 * opts.padding, h: maxY - minY + 2 * opts.padding };
      return { rect: clamp(rect, bounds), circled: true };
    }
  }
  const rect = { x: cursor.x - opts.fallbackW / 2, y: cursor.y - opts.fallbackH / 2, w: opts.fallbackW, h: opts.fallbackH };
  return { rect: clamp(rect, bounds), circled: false };
}
