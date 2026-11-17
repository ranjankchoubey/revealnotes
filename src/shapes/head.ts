// Ported from XNotes core/shapes/Head.kt (MIT, Shardul Vikram Singh).
import { polygonPath, polylinePath, vadd, vdist, vlen, vnorm, vperp, vscale, vsub, type Contour, type Head, type Pt, type Seg, type ShapePath } from "./types";

const DIAMOND_STRETCH = 1.3;
/** A head never eats more of the last segment than this much of it. */
const MIN_KEEP = 0.1;

/** A head's length along the line: never under 12 px, else three and a half widths. */
export const headLength = (width: number): number => Math.max(12, width * 3.5);

/** How far short of the end the line stops, so it never shows through a head with a body. */
export function headInset(head: Head, width: number): number {
  switch (head) {
    case "none":
    case "open":
      return 0;
    case "filled":
    case "hollow_triangle":
      return headLength(width);
    case "filled_diamond":
    case "hollow_diamond":
      return headLength(width) * DIAMOND_STRETCH;
  }
}

/** The head at the line's end [end], pointing along unit [dir], for a line [width] wide. */
export function headPaths(head: Head, end: Pt, dir: Pt, width: number): ShapePath[] {
  if (head === "none" || vlen(dir) < 1e-9) return [];
  const len = headLength(width);
  const perp = vperp(dir);
  switch (head) {
    case "open": {
      // The tip sits half a width past the end so it clears the line's round cap.
      const tip = vadd(end, vscale(dir, width * 0.5));
      const back = vsub(tip, vscale(dir, len));
      return [polylinePath([vadd(back, vscale(perp, len * 0.5)), tip, vsub(back, vscale(perp, len * 0.5))], "HEAD")];
    }
    case "filled":
    case "hollow_triangle": {
      const back = vsub(end, vscale(dir, len));
      const tri = [end, vadd(back, vscale(perp, len * 0.5)), vsub(back, vscale(perp, len * 0.5))];
      return [polygonPath(tri, head === "filled" ? "HEAD_FILLED" : "HEAD")];
    }
    case "filled_diamond":
    case "hollow_diamond": {
      const d = len * DIAMOND_STRETCH;
      const mid = vsub(end, vscale(dir, d / 2));
      const side = vscale(perp, len * 0.4);
      const diamond = [end, vadd(mid, side), vsub(end, vscale(dir, d)), vsub(mid, side)];
      return [polygonPath(diamond, head === "filled_diamond" ? "HEAD_FILLED" : "HEAD")];
    }
  }
}

/**
 * [body]'s open ends with [start] and [end] heads: the line pulled back by each head's inset and
 * the heads added. Nothing changes for a closed body or for no heads.
 */
export function attachHeads(body: ShapePath[], start: Head, end: Head, width: number): ShapePath[] {
  if (start === "none" && end === "none") return body;
  const pathIndex = body.findIndex((p) => p.role === "STROKE_ONLY" && p.contours.some((c) => !c.closed));
  if (pathIndex < 0) return body;
  const path = body[pathIndex];
  const first = path.contours.findIndex((c) => !c.closed);
  let last = path.contours.length - 1;
  while (path.contours[last].closed) last--;
  const contours = path.contours.slice();
  const heads: ShapePath[] = [];
  const e = endOf(contours[last]);
  if (e) {
    heads.push(...headPaths(end, e.at, e.dir, width));
    contours[last] = trimEnd(contours[last], headInset(end, width));
  }
  const s = startOf(contours[first]);
  if (s) {
    heads.push(...headPaths(start, s.at, s.dir, width));
    contours[first] = reverse(trimEnd(reverse(contours[first]), headInset(start, width)));
  }
  const out = body.slice();
  out[pathIndex] = { contours, role: path.role, fillRule: path.fillRule };
  return [...out, ...heads];
}

/** Where a contour ends and the way it is heading there. */
function endOf(c: Contour): { at: Pt; dir: Pt } | null {
  const s = c.segs[c.segs.length - 1];
  if (!s) return null;
  const from = c.segs.length >= 2 ? c.segs[c.segs.length - 2].end : c.start;
  const toward = s.t === "L" ? from : ([s.c2, s.c1, from].find((q) => vdist(q, s.end) > 1e-9) ?? from);
  const d = vsub(s.end, toward);
  return vlen(d) < 1e-9 ? null : { at: s.end, dir: vnorm(d) };
}

const startOf = (c: Contour): { at: Pt; dir: Pt } | null => endOf(reverse(c));

/** [c] traced the other way round. */
function reverse(c: Contour): Contour {
  if (!c.segs.length) return c;
  const pts = [c.start, ...c.segs.map((s) => s.end)];
  const segs: Seg[] = [];
  for (let i = c.segs.length - 1; i >= 0; i--) {
    const to = pts[i];
    const s = c.segs[i];
    segs.push(s.t === "L" ? { t: "L", end: to } : { t: "C", c1: s.c2, c2: s.c1, end: to });
  }
  return { start: pts[pts.length - 1], segs, closed: c.closed };
}

/** [c] with its last [distance] cut off (most of its last segment at most). */
function trimEnd(c: Contour, distance: number): Contour {
  if (distance <= 0 || !c.segs.length) return c;
  const s = c.segs[c.segs.length - 1];
  const from = c.segs.length >= 2 ? c.segs[c.segs.length - 2].end : c.start;
  let cut: Seg;
  if (s.t === "L") {
    const len = vdist(from, s.end);
    if (len < 1e-9) return c;
    const keep = Math.max(len - distance, len * MIN_KEEP) / len;
    cut = { t: "L", end: vadd(from, vscale(vsub(s.end, from), keep)) };
  } else {
    // Walk back along the curve to where it is [distance] from its end, then split there.
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 30; k++) {
      const t = (lo + hi) / 2;
      if (vdist(cubicAt(from, s.c1, s.c2, s.end, t), s.end) > distance) lo = t;
      else hi = t;
    }
    const t = Math.max(lo, MIN_KEEP);
    const a = vadd(from, vscale(vsub(s.c1, from), t));
    const b = vadd(s.c1, vscale(vsub(s.c2, s.c1), t));
    const e = vadd(s.c2, vscale(vsub(s.end, s.c2), t));
    const ab = vadd(a, vscale(vsub(b, a), t));
    const be = vadd(b, vscale(vsub(e, b), t));
    cut = { t: "C", c1: a, c2: ab, end: vadd(ab, vscale(vsub(be, ab), t)) };
  }
  return { start: c.start, segs: [...c.segs.slice(0, -1), cut], closed: c.closed };
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return vadd(vadd(vscale(p0, u * u * u), vscale(p1, 3 * u * u * t)), vadd(vscale(p2, 3 * u * t * t), vscale(p3, t * t * t)));
}
