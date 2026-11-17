import type { Bounds, CanvasDoc, CanvasItem } from "../format/xcanvas";
import { labelCorners, shapePolylines } from "../shapes/item";

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
  if (it.kind === "tape") return it.body.some((poly) => pointInPolygon(poly.map((p): Pt => [p.x, p.y]), x, y));
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

type Pt = [number, number];

/** What an item draws, as polylines, and how far its ink spreads either side of them. */
function drawnOf(it: CanvasItem): { lines: { pts: Pt[]; closed: boolean }[]; reach: number } {
  if (it.kind === "stroke") {
    const c = it.ribbon.centers;
    const pts: Pt[] = [];
    for (let i = 0; i < c.length; i += 2) pts.push([c[i], c[i + 1]]);
    let reach = it.dashed ? it.dashed.width / 2 : 0;
    for (const h of it.ribbon.halfWidths) if (h > reach) reach = h;
    return { lines: [{ pts, closed: false }], reach };
  }
  if (it.kind === "shape") {
    const lines = shapePolylines(it.paths).map((l) => ({ pts: l.pts.map((p): Pt => [p.x, p.y]), closed: l.closed }));
    if (it.label) lines.push({ pts: labelCorners(it.label).map((p): Pt => [p.x, p.y]), closed: true });
    return { lines, reach: it.width / 2 };
  }
  if (it.kind === "tape") {
    return { lines: it.body.map((poly) => ({ pts: poly.map((p): Pt => [p.x, p.y]), closed: true })), reach: 0 };
  }
  if (it.kind === "image") {
    return { lines: [{ pts: it.corners.map((p): Pt => [p.x, p.y]), closed: true }], reach: 0 };
  }
  const b = it.bounds;
  return { lines: [{ pts: [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]], closed: true }], reach: 0 };
}

function pointInPolygon(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    distToSegment(a[0], a[1], c[0], c[1], d[0], d[1])[0],
    distToSegment(b[0], b[1], c[0], c[1], d[0], d[1])[0],
    distToSegment(c[0], c[1], a[0], a[1], b[0], b[1])[0],
    distToSegment(d[0], d[1], a[0], a[1], b[0], b[1])[0],
  );
}

/**
 * XNotes' selection rule (canvas/SelectionMath.kt), shared by the lasso and the box: an item is in
 * when the closed ring touches what the item draws (its ink, a shape's outline, a box's frame) or
 * goes all the way round it.
 */
export function ringMembers(items: CanvasItem[], ring: Pt[]): CanvasItem[] {
  if (ring.length < 3) return [];
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of ring) {
    box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x); box.maxY = Math.max(box.maxY, y);
  }
  const n = ring.length;
  return items.filter((it) => {
    const b = it.bounds;
    if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) return false;
    const { lines, reach } = drawnOf(it);
    // A line starting inside is in; one starting outside must cross or touch an edge near the item.
    for (const l of lines) if (l.pts.length && pointInPolygon(ring, l.pts[0][0], l.pts[0][1])) return true;
    const near: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % n];
      if (Math.min(a[0], c[0]) <= b.maxX && Math.max(a[0], c[0]) >= b.minX && Math.min(a[1], c[1]) <= b.maxY && Math.max(a[1], c[1]) >= b.minY) near.push(i);
    }
    if (!near.length) return false;
    for (const l of lines) {
      const v = l.pts;
      if (v.length === 1) {
        if (near.some((e) => distToSegment(v[0][0], v[0][1], ring[e][0], ring[e][1], ring[(e + 1) % n][0], ring[(e + 1) % n][1])[0] <= reach)) return true;
        continue;
      }
      const segs = l.closed ? v.length : v.length - 1;
      for (let k = 0; k < segs; k++) {
        const p = v[k];
        const q = v[(k + 1) % v.length];
        for (const e of near) if (segSegDist(p, q, ring[e], ring[(e + 1) % n]) <= reach) return true;
      }
    }
    return false;
  });
}

export const boxRing = (r: Bounds): Pt[] => [[r.minX, r.minY], [r.maxX, r.minY], [r.maxX, r.maxY], [r.minX, r.maxY]];
