// Ported from XNotes core/shapes/FreePath.kt (MIT, Shardul Vikram Singh).
import { bounding, lines as contourLines, mapContour, pt, vadd, vdist, vscale, type Contour, type Pt, type Rect, type Seg } from "./types";

/** A contour of straight edges through [points]. */
export const lines = (points: Pt[], closed: boolean): Contour => contourLines(points, closed);

/** [contours] moved by [f], control points included. */
export const map = (contours: Contour[], f: (p: Pt) => Pt): Contour[] => contours.map((c) => mapContour(c, f));

/** Page-space [contours] as fractions of [box]. A box with no width or height keeps that axis as is. */
export function normalize(contours: Contour[], box: Rect): Contour[] {
  const w = box.w > 1e-9 ? box.w : 1;
  const h = box.h > 1e-9 ? box.h : 1;
  return map(contours, (p) => pt((p.x - box.x) / w, (p.y - box.y) / h));
}

/** Normalized [contours] placed in [box]. */
export const place = (contours: Contour[], box: Rect): Contour[] => map(contours, (p) => pt(box.x + p.x * box.w, box.y + p.y * box.h));

/** The points the contour passes through: its start and every segment's end, a closing repeat dropped. */
export function vertices(c: Contour): Pt[] {
  const out = [c.start, ...c.segs.map((s) => s.end)];
  if (c.closed && out.length > 1 && vdist(out[out.length - 1], out[0]) < 1e-12) out.pop();
  return out;
}

/** True for one contour of straight edges: what the plain vertex list of older files can hold. */
export const isVertexList = (contours: Contour[]): boolean => contours.length === 1 && contours[0].segs.every((s) => s.t === "L");

/** The exact bounds of what [contours] draw: a curve counts by its extremes, never its handles. */
export function bounds(contours: Contour[]): Rect | null {
  const pts: Pt[] = [];
  for (const c of contours) {
    pts.push(c.start);
    let from = c.start;
    for (const s of c.segs) {
      pts.push(s.end);
      if (s.t === "C") extremes(from, s.c1, s.c2, s.end, pts);
      from = s.end;
    }
  }
  return pts.length ? bounding(pts) : null;
}

/** Add the points where a cubic turns back in x or in y: the roots of its derivative in (0, 1). */
function extremes(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: Pt[]): void {
  const roots = (a0: number, a1: number, a2: number, a3: number): number[] => {
    const d0 = a1 - a0;
    const d1 = a2 - a1;
    const d2 = a3 - a2;
    const a = d0 - 2 * d1 + d2;
    const b = 2 * (d1 - d0);
    if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-d0 / b];
    const disc = b * b - 4 * a * d0;
    if (disc < 0) return [];
    const sq = Math.sqrt(disc);
    return [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
  };
  for (const t of [...roots(p0.x, p1.x, p2.x, p3.x), ...roots(p0.y, p1.y, p2.y, p3.y)]) {
    if (t <= 0 || t >= 1) continue;
    const u = 1 - t;
    out.push(vadd(vadd(vscale(p0, u * u * u), vscale(p1, 3 * u * u * t)), vadd(vscale(p2, 3 * u * t * t), vscale(p3, t * t * t))));
  }
}

/** [contours] as SVG path data (absolute M, L, C and Z), the form files store a free outline in. */
export function toSvg(contours: Contour[]): string {
  let sb = "";
  for (const c of contours) {
    if (sb.length) sb += " ";
    sb += `M${num(c.start.x)},${num(c.start.y)}`;
    for (const s of c.segs) {
      if (s.t === "L") sb += ` L${num(s.end.x)},${num(s.end.y)}`;
      else sb += ` C${num(s.c1.x)},${num(s.c1.y)} ${num(s.c2.x)},${num(s.c2.y)} ${num(s.end.x)},${num(s.end.y)}`;
    }
    if (c.closed) sb += " Z";
  }
  return sb;
}

const TOKEN = /[MLCZ]|-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g;

/** SVG path data written by [toSvg] read back; null when it holds nothing usable. */
export function fromSvg(data: string | null | undefined): Contour[] | null {
  if (data == null || data.trim() === "") return null;
  const tokens = data.match(TOKEN) ?? [];
  const out: Contour[] = [];
  let start: Pt | null = null;
  let segs: Seg[] = [];
  let i = 0;
  const flush = (closed: boolean): void => {
    if (start) out.push({ start, segs, closed });
    start = null;
    segs = [];
  };
  const num = (): number | null => {
    const tok = tokens[i++];
    if (tok === undefined) return null;
    const v = Number(tok);
    return Number.isNaN(v) ? null : v;
  };
  const point = (): Pt | null => {
    const x = num();
    if (x === null) return null;
    const y = num();
    if (y === null) return null;
    return Number.isFinite(x) && Number.isFinite(y) ? pt(x, y) : null;
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd !== "M" && start === null) return null; // every contour opens with a move
    if (cmd === "M") {
      flush(false);
      start = point();
      if (!start) return null;
    } else if (cmd === "L") {
      const e = point();
      if (!e) return null;
      segs.push({ t: "L", end: e });
    } else if (cmd === "C") {
      const c1 = point();
      if (!c1) return null;
      const c2 = point();
      if (!c2) return null;
      const e = point();
      if (!e) return null;
      segs.push({ t: "C", c1, c2, end: e });
    } else if (cmd === "Z") {
      flush(true);
    } else {
      return null;
    }
  }
  flush(false);
  return out.length ? out : null;
}

/** Six places is a millionth of the box: far finer than a pixel on any box that fits a screen. */
function num(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  if (r === Math.round(r) && Math.abs(r) < 1e15) return String(Math.trunc(r));
  return javaDouble(r);
}

/** Java's Double.toString layout: scientific ("1.5E-4") outside [1e-3, 1e7). */
function javaDouble(r: number): string {
  const a = Math.abs(r);
  if (!Number.isFinite(r) || (a >= 1e-3 && a < 1e7)) return String(r);
  const [m, e] = r.toExponential().split("e");
  return `${m.includes(".") ? m : `${m}.0`}E${e.startsWith("+") ? e.slice(1) : e}`;
}
