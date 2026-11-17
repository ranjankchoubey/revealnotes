// Shape geometry, ported from XNotes core/shapes (MIT, Shardul Vikram Singh). Same names and semantics.

export interface Pt {
  x: number;
  y: number;
}

/** x, y = top-left; w, h >= 0. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Seg = { t: "L"; end: Pt } | { t: "C"; c1: Pt; c2: Pt; end: Pt };

export interface Contour {
  start: Pt;
  segs: Seg[];
  closed: boolean;
}

/** How a path is painted (XNotes PathRole). */
export type PathRole = "OUTLINE" | "STROKE_ONLY" | "FILL_ONLY" | "HIDDEN" | "SHADE_DARK" | "SHADE_LIGHT" | "HEAD" | "HEAD_FILLED";

export interface ShapePath {
  contours: Contour[];
  role: PathRole;
  fillRule: "nonzero" | "evenodd";
}

export interface ShapeGeometry {
  paths: ShapePath[];
  /** The area a label wraps in, unturned frame. */
  textRect: Rect;
}

export interface ShapeParams {
  adj: number[];
  n: number;
  /** A free kind's outline, normalized to the box (0..1 both axes); null for the rest. */
  path: Contour[] | null;
  /** Outline width, which sizes arrowheads a kind draws itself. */
  width: number;
}

export type Flip = "" | "x" | "y" | "xy";
export type Head = "none" | "open" | "filled" | "hollow_triangle" | "filled_diamond" | "hollow_diamond";

export interface ShapeKind {
  id: string;
  isClosed: boolean;
  /** Line and arrow: drawn from two endpoints, not a box. */
  isEndpointShape: boolean;
  /** Polygon, polyline, curve, glyphs, fill: outline stored with the shape. */
  isFree: boolean;
  defaultAdj: number[];
  defaultN: number;
  defaultHeadStart: Head;
  defaultHeadEnd: Head;
  build(box: Rect, p: ShapeParams): ShapeGeometry;
}

export const pt = (x: number, y: number): Pt => ({ x, y });
export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
export const rectFromPoints = (a: Pt, b: Pt): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

export const KAPPA = 0.5522847498307936;

export function lines(points: Pt[], closed: boolean): Contour {
  if (!points.length) return { start: pt(0, 0), segs: [], closed };
  return { start: points[0], segs: points.slice(1).map((end) => ({ t: "L", end })), closed };
}

export const polygonPath = (points: Pt[], role: PathRole = "OUTLINE"): ShapePath => ({ contours: [lines(points, true)], role, fillRule: "nonzero" });
export const polylinePath = (points: Pt[], role: PathRole = "STROKE_ONLY"): ShapePath => ({ contours: [lines(points, false)], role, fillRule: "nonzero" });
export const rectPath = (r: Rect, role: PathRole = "OUTLINE"): ShapePath =>
  polygonPath([pt(r.x, r.y), pt(r.x + r.w, r.y), pt(r.x + r.w, r.y + r.h), pt(r.x, r.y + r.h)], role);

export function ellipseContour(cx: number, cy: number, rx: number, ry: number): Contour {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    start: pt(cx + rx, cy),
    segs: [
      { t: "C", c1: pt(cx + rx, cy + ky), c2: pt(cx + kx, cy + ry), end: pt(cx, cy + ry) },
      { t: "C", c1: pt(cx - kx, cy + ry), c2: pt(cx - rx, cy + ky), end: pt(cx - rx, cy) },
      { t: "C", c1: pt(cx - rx, cy - ky), c2: pt(cx - kx, cy - ry), end: pt(cx, cy - ry) },
      { t: "C", c1: pt(cx + kx, cy - ry), c2: pt(cx + rx, cy - ky), end: pt(cx + rx, cy) },
    ],
    closed: true,
  };
}

export const ellipsePath = (cx: number, cy: number, rx: number, ry: number, role: PathRole = "OUTLINE"): ShapePath => ({
  contours: [ellipseContour(cx, cy, rx, ry)],
  role,
  fillRule: "nonzero",
});

/** A box's inner area a label wraps in: inset by a little of its shorter side (ShapeKind.inset). */
export function inset(box: Rect, frac = 0.06): Rect {
  const d = Math.min(box.w, box.h) * frac;
  return rect(box.x + d, box.y + d, Math.max(0, box.w - 2 * d), Math.max(0, box.h - 2 * d));
}

export function mapContour(c: Contour, f: (p: Pt) => Pt): Contour {
  return {
    start: f(c.start),
    segs: c.segs.map((s) => (s.t === "L" ? { t: "L", end: f(s.end) } : { t: "C", c1: f(s.c1), c2: f(s.c2), end: f(s.end) })),
    closed: c.closed,
  };
}

export const mapPath = (p: ShapePath, f: (p: Pt) => Pt): ShapePath => ({ ...p, contours: p.contours.map((c) => mapContour(c, f)) });

// Pt arithmetic (XNotes geometry/Pt.kt).
export const vadd = (a: Pt, b: Pt): Pt => pt(a.x + b.x, a.y + b.y);
export const vsub = (a: Pt, b: Pt): Pt => pt(a.x - b.x, a.y - b.y);
export const vscale = (a: Pt, s: number): Pt => pt(a.x * s, a.y * s);
export const vlen = (a: Pt): number => Math.hypot(a.x, a.y);
export const vdist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export function vnorm(a: Pt): Pt {
  const l = vlen(a);
  return l < 1e-12 ? pt(0, 0) : pt(a.x / l, a.y / l);
}
/** Rotate 90 degrees: (x, y) -> (-y, x). */
export const vperp = (a: Pt): Pt => pt(-a.y, a.x);

/** Rect.bounding: tight bounds of [points]; an empty rect for none. */
export function bounding(points: Pt[]): Rect {
  if (!points.length) return rect(0, 0, 0, 0);
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = minX;
  let maxY = minY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return rect(minX, minY, maxX - minX, maxY - minY);
}

/** Kotlin coerceIn: NaN passes through. */
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Flip.map: mirror [p] inside [box]. */
export function flipPoint(flip: Flip, p: Pt, box: Rect): Pt {
  return pt(flip.includes("x") ? 2 * box.x + box.w - p.x : p.x, flip.includes("y") ? 2 * box.y + box.h - p.y : p.y);
}
