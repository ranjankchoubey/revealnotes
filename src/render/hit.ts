import type { Bounds, CanvasDoc, CanvasItem } from "../format/xcanvas";

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)), t];
}

const inBounds = (b: Bounds, x: number, y: number, pad: number) =>
  x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;

/** True when (x, y) lies on the item's drawn geometry, within [tol] content px. */
export function hitItem(it: CanvasItem, x: number, y: number, tol: number): boolean {
  if (!inBounds(it.bounds, x, y, tol)) return false;
  if (it.kind !== "stroke") return true;
  const c = it.ribbon.centers;
  const h = it.ribbon.halfWidths;
  const minR = it.dashed ? it.dashed.width / 2 : 0;
  const n = h.length;
  if (n === 1) return Math.hypot(x - c[0], y - c[1]) <= Math.max(h[0], minR) + tol;
  for (let i = 1; i < n; i++) {
    const [d, t] = distToSegment(x, y, c[2 * i - 2], c[2 * i - 1], c[2 * i], c[2 * i + 1]);
    const r = Math.max(h[i - 1] + (h[i] - h[i - 1]) * t, minR);
    if (d <= r + tol) return true;
  }
  return false;
}

/** Topmost visible item under (x, y). */
export function pickAt(doc: CanvasDoc, x: number, y: number, tol: number, visible?: (it: CanvasItem) => boolean): CanvasItem | null {
  for (let i = doc.items.length - 1; i >= 0; i--) {
    const it = doc.items[i];
    if (visible && !visible(it)) continue;
    if (hitItem(it, x, y, tol)) return it;
  }
  return null;
}

/** Box test on real geometry: a stroke counts when at least 60% of its points are inside, so a tail
 *  poking out doesn't exclude it and a neighbour barely clipped isn't grabbed. */
export function itemInBox(it: CanvasItem, r: Bounds): boolean {
  const b = it.bounds;
  if (b.maxX < r.minX || b.minX > r.maxX || b.maxY < r.minY || b.minY > r.maxY) return false;
  if (it.kind !== "stroke") return inBounds(r, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
  const c = it.ribbon.centers;
  const n = c.length / 2;
  let inside = 0;
  for (let i = 0; i < n; i++) if (inBounds(r, c[2 * i], c[2 * i + 1], 0)) inside++;
  return inside >= 0.6 * n;
}
