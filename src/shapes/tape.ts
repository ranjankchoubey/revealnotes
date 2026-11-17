// Ported from XNotes core/tape/TapeGeometry.kt and core/model/TapeItem.kt (MIT, Shardul Vikram Singh).
import { bounding, pt, vdist, type Pt, type Rect } from "./types";

export type TapeMode = "straight" | "rectangle" | "freehand";
export type TapePattern = "solid" | "stripes" | "dots" | "grid";

export interface TapeShape {
  mode: TapeMode;
  points: Pt[];
  width: number;
}

const CORNER = 4.0;
const STRIPE_PITCH = 14.0;
const STRIPE_BAND = 6.0;
const DOT_PITCH = 12.0;
const DOT_RADIUS = 2.2;
const GRID_PITCH = 12.0;
const GRID_LINE = 1.4;
export const TAPE_OUTLINE_WIDTH = 1.6;
export const TAPE_DASH: [number, number] = [7.0, 5.0];
const ARC_TOLERANCE = 0.05;
const EDGE_STEP = 2.0;
export const TAPE_DEFAULT_WIDTH = 36.0;

function arcSegments(r: number, sweep: number): number {
  if (r <= ARC_TOLERANCE) return 2;
  const step = 2.0 * Math.acos(1.0 - ARC_TOLERANCE / r);
  return Math.min(48, Math.max(2, Math.ceil(sweep / step)));
}

export function axes(a: Pt, b: Pt): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const u = len < 1e-9 ? pt(1, 0) : pt(dx / len, dy / len);
  return [u, pt(-u.y, u.x)];
}

/** A capsule round [a]-[b] with radius [r]: a disc when they meet. Convex. */
export function capsule(a: Pt, b: Pt, r: number): Pt[] {
  const n = arcSegments(r, Math.PI);
  const theta = vdist(a, b) < 1e-9 ? 0 : Math.atan2(b.y - a.y, b.x - a.x);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const phi = theta - Math.PI / 2 + (Math.PI * i) / n;
    out.push(pt(b.x + r * Math.cos(phi), b.y + r * Math.sin(phi)));
  }
  for (let i = 0; i <= n; i++) {
    const phi = theta + Math.PI / 2 + (Math.PI * i) / n;
    out.push(pt(a.x + r * Math.cos(phi), a.y + r * Math.sin(phi)));
  }
  return out;
}

function roundedBox(a: Pt, b: Pt, h: number): Pt[] {
  const [u, v] = axes(a, b);
  const len = vdist(a, b);
  const rc = Math.max(0, Math.min(CORNER, Math.min(h, len / 2)));
  const at = (x: number, y: number) => pt(a.x + u.x * x + v.x * y, a.y + u.y * x + v.y * y);
  if (rc <= 1e-9) return [at(0, -h), at(len, -h), at(len, h), at(0, h)];
  const m = arcSegments(rc, Math.PI / 2);
  const out: Pt[] = [];
  const centres: [Pt, number][] = [
    [pt(len - rc, -h + rc), -Math.PI / 2],
    [pt(len - rc, h - rc), 0],
    [pt(rc, h - rc), Math.PI / 2],
    [pt(rc, -h + rc), Math.PI],
  ];
  for (const [c, start] of centres) {
    for (let i = 0; i <= m; i++) {
      const phi = start + (Math.PI / 2) * (i / m);
      out.push(at(c.x + rc * Math.cos(phi), c.y + rc * Math.sin(phi)));
    }
  }
  return out;
}

/** The body as convex pieces, back to front; the union is the tape. */
export function tapeBody(s: TapeShape): Pt[][] {
  const half = s.width / 2;
  if (s.mode === "straight") return [capsule(s.points[0], s.points[1] ?? s.points[0], half)];
  if (s.mode === "rectangle") return [roundedBox(s.points[0], s.points[1] ?? s.points[0], half)];
  if (s.points.length === 1) return [capsule(s.points[0], s.points[0], half)];
  return s.points.slice(0, -1).map((p, i) => capsule(p, s.points[i + 1], half));
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function densify(ring: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const n = Math.max(1, Math.ceil(vdist(a, b) / EDGE_STEP));
    for (let s = 0; s < n; s++) out.push(pt(a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n));
  }
  return out;
}

const overlaps = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** The edge a peeled tape shows: each piece's boundary, keeping only the parts no other capsule covers. */
export function tapeOutline(s: TapeShape): { pts: Pt[]; closed: boolean }[] {
  const pieces = tapeBody(s);
  if (pieces.length === 1) return [{ pts: pieces[0], closed: true }];
  const h = s.width / 2;
  const boxes = pieces.map(bounding);
  const inner = h * (1 - 1e-6) - 1e-6;
  const out: { pts: Pt[]; closed: boolean }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const near = pieces.map((_, j) => j).filter((j) => j !== i && overlaps(boxes[j], boxes[i]));
    const ring = densify(pieces[i]);
    const kept = ring.map((q) => !near.some((j) => distToSeg(q, s.points[j], s.points[j + 1]) < inner));
    if (kept.every(Boolean)) {
      out.push({ pts: ring, closed: true });
      continue;
    }
    const start = kept.indexOf(false);
    let run: Pt[] = [];
    for (let step = 1; step <= ring.length; step++) {
      const k = (start + step) % ring.length;
      if (kept[k]) run.push(ring[k]);
      else if (run.length) {
        if (run.length >= 2) out.push({ pts: run, closed: false });
        run = [];
      }
    }
    if (run.length >= 2) out.push({ pts: run, closed: false });
  }
  return out;
}

function signedArea(ring: Pt[]): number {
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function crossing(p: Pt, q: Pt, a: Pt, b: Pt): Pt | null {
  const ex = b.x - a.x, ey = b.y - a.y, dx = q.x - p.x, dy = q.y - p.y;
  const den = ex * dy - ey * dx;
  if (Math.abs(den) < 1e-12) return null;
  const t = (ex * (a.y - p.y) - ey * (a.x - p.x)) / den;
  return pt(p.x + dx * t, p.y + dy * t);
}

/** Sutherland-Hodgman: convex [subject] clipped to convex [clip]. */
function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
  if (subject.length < 3 || clip.length < 3) return [];
  const sign = signedArea(clip) >= 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Pt) => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0;
    const next: Pt[] = [];
    for (let k = 0; k < out.length; k++) {
      const cur = out[k];
      const prev = out[(k + out.length - 1) % out.length];
      if (inside(cur)) {
        if (!inside(prev)) {
          const c = crossing(prev, cur, a, b);
          if (c) next.push(c);
        }
        next.push(cur);
      } else if (inside(prev)) {
        const c = crossing(prev, cur, a, b);
        if (c) next.push(c);
      }
    }
    out = next;
  }
  return out;
}

function stripes(box: Rect): Pt[][] {
  const r2 = Math.SQRT2;
  const lo = (box.x - (box.y + box.h)) / r2;
  const hi = (box.x + box.w - box.y) / r2;
  const along = pt(1 / r2, 1 / r2);
  const across = pt(1 / r2, -1 / r2);
  const reach = Math.hypot(box.w, box.h) + 1;
  const mid = pt(box.x + box.w / 2, box.y + box.h / 2);
  const t0 = mid.x * along.x + mid.y * along.y;
  const out: Pt[][] = [];
  for (let k = Math.floor((lo - STRIPE_BAND) / STRIPE_PITCH); k * STRIPE_PITCH <= hi; k++) {
    const s0 = k * STRIPE_PITCH;
    const s1 = s0 + STRIPE_BAND;
    const p = (s: number, t: number) => pt(across.x * s + along.x * t, across.y * s + along.y * t);
    out.push([p(s0, t0 - reach), p(s1, t0 - reach), p(s1, t0 + reach), p(s0, t0 + reach)]);
  }
  return out;
}

function dots(box: Rect): Pt[][] {
  const out: Pt[][] = [];
  const n = arcSegments(DOT_RADIUS, 2 * Math.PI);
  for (let j = Math.floor((box.y - DOT_RADIUS) / DOT_PITCH); j * DOT_PITCH <= box.y + box.h + DOT_RADIUS; j++) {
    const shift = j % 2 !== 0 ? DOT_PITCH / 2 : 0;
    for (let i = Math.floor((box.x - DOT_RADIUS - shift) / DOT_PITCH); i * DOT_PITCH + shift <= box.x + box.w + DOT_RADIUS; i++) {
      const cx = i * DOT_PITCH + shift;
      const cy = j * DOT_PITCH;
      out.push(Array.from({ length: n }, (_, k) => pt(cx + DOT_RADIUS * Math.cos((2 * Math.PI * k) / n), cy + DOT_RADIUS * Math.sin((2 * Math.PI * k) / n))));
    }
  }
  return out;
}

function grid(box: Rect): Pt[][] {
  const out: Pt[][] = [];
  const half = GRID_LINE / 2;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  for (let i = Math.floor(box.x / GRID_PITCH); i * GRID_PITCH <= right + half; i++) {
    const x = i * GRID_PITCH;
    out.push([pt(x - half, box.y - 1), pt(x + half, box.y - 1), pt(x + half, bottom + 1), pt(x - half, bottom + 1)]);
  }
  for (let j = Math.floor(box.y / GRID_PITCH); j * GRID_PITCH <= bottom + half; j++) {
    const y = j * GRID_PITCH;
    out.push([pt(box.x - 1, y - half), pt(right + 1, y - half), pt(right + 1, y + half), pt(box.x - 1, y + half)]);
  }
  return out;
}

/** The pattern printed on the body as convex polygons, each inside one body piece. */
export function tapePattern(s: TapeShape, pattern: TapePattern): Pt[][] {
  if (pattern === "solid") return [];
  const [u, v] = s.mode === "freehand" ? [pt(1, 0), pt(0, 1)] : axes(s.points[0], s.points[1] ?? s.points[0]);
  const o = s.points[0];
  const toLocal = (p: Pt) => pt((p.x - o.x) * u.x + (p.y - o.y) * u.y, (p.x - o.x) * v.x + (p.y - o.y) * v.y);
  const toWorld = (p: Pt) => pt(o.x + u.x * p.x + v.x * p.y, o.y + u.y * p.x + v.y * p.y);
  const out: Pt[][] = [];
  for (const piece of tapeBody(s)) {
    const local = piece.map(toLocal);
    const box = bounding(local);
    const prims = pattern === "stripes" ? stripes(box) : pattern === "dots" ? dots(box) : grid(box);
    for (const prim of prims) {
      const clipped = clipConvex(prim, local);
      if (clipped.length >= 3) out.push(clipped.map(toWorld));
    }
  }
  return out;
}

/** The pattern's shade of the cover colour: darker on a light tape, lighter on a dark one (TapeItem.printColor). */
export function tapePrintColor(c: [number, number, number]): [number, number, number] {
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const mix = (to: number, f: number) => c.map((v) => Math.round(v + (to - v) * f)) as [number, number, number];
  return lum > 0.3 ? mix(0, 0.28) : mix(255, 0.32);
}
