// A saved XNotes shape, connector, glyphs or fill item turned into page-space paths and a placed
// label, following core/model/ShapeItem.kt, ConnectorItem.kt and format/CanvasCodec.kt (MIT).
import { fontFor, naturalWidth, ptToPx, wrap } from "../format/text";
import * as FP from "./freePath";
import { attachHeads } from "./head";
import { kindById } from "./kinds";
import {
  bounding, clamp, flipPoint, mapPath, polygonPath, polylinePath, pt, rectFromPoints,
  type Contour, type Flip, type Head, type Pt, type Rect, type ShapeKind, type ShapePath,
} from "./types";

type Rgba = [number, number, number, number];

export interface LabelDraw {
  lines: string[];
  font: string;
  size: number;
  lineHeight: number;
  color: Rgba;
  /** Centre of the label frame on the page; the frame turns about it. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

export interface ShapeDraw {
  kindId: string;
  paths: ShapePath[];
  label: LabelDraw | null;
}

const HEADS = new Set<Head>(["none", "open", "filled", "hollow_triangle", "filled_diamond", "hollow_diamond"]);
const headOf = (v: unknown, d: Head): Head => (typeof v === "string" && HEADS.has(v as Head) ? (v as Head) : d);
const flipOf = (v: unknown): Flip => (v === "x" || v === "y" || v === "xy" ? v : "");
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// ShapeLabel / ConnectorItem constants.
const MIN_WIDTH_LINES = 2;
const MAX_WIDTH_LINES = 16;
const LABEL_SLACK = 2;
const LABEL_GAP_LINES = 0.2;
const LINE_HEIGHT = 1.2;
const FLATTEN_STEPS = 16;

/** The points a contour passes through, curves cut into short lines. */
export function flatten(c: Contour): Pt[] {
  const out = [c.start];
  let from = c.start;
  for (const s of c.segs) {
    if (s.t === "L") out.push(s.end);
    else {
      for (let i = 1; i <= FLATTEN_STEPS; i++) {
        const t = i / FLATTEN_STEPS;
        const u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
        out.push(pt(a * from.x + b * s.c1.x + d * s.c2.x + e * s.end.x, a * from.y + b * s.c1.y + d * s.c2.y + e * s.end.y));
      }
    }
    from = s.end;
  }
  if (c.closed && out.length > 2) out.push(c.start);
  return out;
}

function pointAt(pts: Pt[], share: number): Pt {
  if (pts.length < 2) return pts[0] ?? pt(0, 0);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let want = clamp(share, 0, 1) * total;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (want <= d && d > 0) return pt(pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * want) / d, pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * want) / d);
    want -= d;
  }
  return pts[pts.length - 1];
}

/** The parameter span of segment a→b inside [r] (Liang–Barsky), or null when it misses. */
function inside(a: Pt, b: Pt, r: Rect): [number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  return [t0, t1];
}

/** The runs of an open contour outside [r] (ConnectorPaths.clipOut), as straight-edged contours. */
function clipOut(c: Contour, r: Rect): Contour[] {
  const pts = flatten(c);
  const runs: Pt[][] = [];
  let run: Pt[] = [pts[0]];
  const lerp = (a: Pt, b: Pt, t: number) => pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const span = inside(a, b, r);
    if (!span) {
      run.push(b);
      continue;
    }
    if (span[0] > 0) run.push(lerp(a, b, span[0]));
    if (run.length >= 2) runs.push(run);
    run = span[1] < 1 ? [lerp(a, b, span[1]), b] : [];
    if (!run.length && i + 1 < pts.length) run = [b];
  }
  if (run.length >= 2) runs.push(run);
  return runs.map((p) => FP.lines(p, false));
}

interface LabelSpec { text: string; color: Rgba; font: string; size: number; lineHeight: number; at: number }

function labelOf(raw: Record<string, unknown>): LabelSpec | null {
  const l = raw.label as Record<string, unknown> | undefined;
  if (!l || typeof l !== "object" || typeof l.text !== "string" || !l.text) return null;
  const c = Array.isArray(l.rgba) ? l.rgba : [];
  const size = ptToPx(num(l.point_size, 13));
  return {
    text: l.text,
    color: [num(c[0], 0), num(c[1], 0), num(c[2], 0), num(c[3], 255)],
    font: fontFor(l.font_face),
    size,
    lineHeight: size * LINE_HEIGHT,
    at: num(l.at, 0.5),
  };
}

/** A label on the open line [line]: as wide as its longest line, clamped, centred [at] of the way along. */
function onLine(l: LabelSpec, line: Contour): Rect {
  const w = clamp(Math.ceil(naturalWidth(l.text, l.font, l.size)) + LABEL_SLACK, l.lineHeight * MIN_WIDTH_LINES, l.lineHeight * MAX_WIDTH_LINES);
  const h = wrap(l.text, w, l.font, l.size).length * l.lineHeight;
  const c = pointAt(flatten(line), l.at);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

function placed(l: LabelSpec, frame: Rect, centre: Pt, rotation: number): LabelDraw {
  return {
    lines: wrap(l.text, frame.w, l.font, l.size),
    font: l.font, size: l.size, lineHeight: l.lineHeight, color: l.color,
    cx: centre.x, cy: centre.y, w: frame.w, h: frame.h, rotation,
  };
}

/** Open stroked runs broken round [gap], as XNotes leaves room for a label on a line. */
function breakAround(paths: ShapePath[], gap: Rect): ShapePath[] {
  return paths.map((p) =>
    p.role !== "STROKE_ONLY" ? p : { ...p, contours: p.contours.flatMap((c) => (c.closed ? [c] : clipOut(c, gap))) },
  );
}

const outset = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

function flipRect(flip: Flip, r: Rect, box: Rect): Rect {
  if (!flip) return r;
  return rectFromPoints(flipPoint(flip, pt(r.x, r.y), box), flipPoint(flip, pt(r.x + r.w, r.y + r.h), box));
}

/**
 * Page-space geometry for a shape-like item. [dx, dy] place a note page's items on the document.
 * Null when there is nothing drawable (unknown kind and no stand-in outline).
 */
export function buildShape(raw: Record<string, unknown>, dx = 0, dy = 0): ShapeDraw | null {
  const P = (v: unknown): Pt | null =>
    Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" ? pt(v[0] + dx, v[1] + dy) : null;
  const pts = Array.isArray(raw.points) ? (raw.points as unknown[]).map(P).filter((p): p is Pt => !!p) : [];
  const width = num(raw.stroke_width, 2);
  const label = labelOf(raw);

  // A connector: the polyline it was flattened to, heads at its ends, the label riding the line.
  if (raw.connector) {
    if (pts.length < 2) return null;
    const line = FP.lines(pts, false);
    let paths = attachHeads([polylinePath(pts)], headOf(raw.head_start, "none"), headOf(raw.head_end, "none"), width);
    if (!label) return { kindId: "connector", paths, label: null };
    const frame = onLine(label, line);
    paths = breakAround(paths, outset(frame, label.lineHeight * LABEL_GAP_LINES));
    return { kindId: "connector", paths, label: placed(label, frame, pt(frame.x + frame.w / 2, frame.y + frame.h / 2), 0) };
  }

  const own = raw.kind === "glyphs" || raw.kind === "fill";
  const legacy = kindById((own ? raw.kind : raw.shape) as string);
  const r = Array.isArray(raw.rect) && raw.rect.length >= 4 ? (raw.rect as unknown[]).map((v) => num(v, 0)) : null;
  const frame = r ? { x: r[0] + dx, y: r[1] + dy, w: r[2], h: r[3] } : null;
  const geomId = typeof raw.geom === "string" ? raw.geom : typeof raw.flip_geom === "string" ? raw.flip_geom : undefined;
  const angle = num(raw.angle, 0);
  const svg = FP.fromSvg(typeof raw.path === "string" ? raw.path : null);

  let kind: ShapeKind | undefined;
  let box: Rect;
  let rotation = 0;
  let path: Contour[] | null = null;
  const start = P(raw.start);
  const end = P(raw.end);
  if (frame && (geomId || angle !== 0 || svg || own)) {
    kind = kindById(geomId) ?? legacy;
    box = frame;
    rotation = angle;
    if (kind?.isFree) {
      const c = pt(box.x + box.w / 2, box.y + box.h / 2);
      const cs = Math.cos(-angle), sn = Math.sin(-angle);
      const unturn = (p: Pt) => pt(c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, c.y + (p.x - c.x) * sn + (p.y - c.y) * cs);
      path = svg ?? (pts.length >= 2 ? FP.normalize([FP.lines(pts.map(unturn), kind.isClosed)], box) : null);
    }
  } else {
    kind = legacy;
    if (start && end) box = rectFromPoints(start, end);
    else if (pts.length) box = bounding(pts);
    else return null;
    if (kind?.isFree) path = pts.length >= 2 ? FP.normalize([FP.lines(pts, kind.isClosed)], box) : null;
  }

  // A kind newer than this port: draw the outline older readers get.
  if (!kind) {
    if (pts.length < 2) return null;
    const closed = raw.shape !== "polyline" && raw.shape !== "line" && raw.shape !== "arrow";
    return { kindId: String(raw.shape ?? "?"), paths: [closed ? polygonPath(pts) : polylinePath(pts)], label: null };
  }

  let paths: ShapePath[];
  let textRect: Rect;
  if (kind.isEndpointShape && start && end) {
    paths = [polylinePath([start, end])];
    textRect = rectFromPoints(start, end);
  } else {
    const n = num(raw.n, 0) > 0 ? num(raw.n, kind.defaultN) : kind.defaultN;
    const adj = Array.isArray(raw.adj) ? (raw.adj as unknown[]).map((v) => num(v, NaN)) : kind.defaultAdj;
    const g = kind.build(box, { adj, n, path, width });
    const flip = kind.isFree || kind.isEndpointShape ? "" : flipOf(raw.flip);
    paths = flip ? g.paths.map((p) => mapPath(p, (q) => flipPoint(flip, q, box))) : g.paths;
    textRect = flipRect(flip, g.textRect, box);
  }
  const hs = headOf(raw.head_start, kind.defaultHeadStart);
  const he = headOf(raw.head_end, kind.defaultHeadEnd);
  if (!kind.isClosed && (hs !== "none" || he !== "none")) paths = attachHeads(paths, hs, he, width);

  let labelDraw: LabelDraw | null = null;
  if (label) {
    let lf: Rect | null = null;
    if (!kind.isClosed) {
      const line = paths.find((p) => p.role === "STROKE_ONLY")?.contours.find((c) => c.segs.length > 0);
      if (line) {
        lf = onLine(label, line);
        paths = breakAround(paths, outset(lf, label.lineHeight * LABEL_GAP_LINES));
      }
    }
    if (!lf) {
      const w = Math.max(textRect.w, label.lineHeight * MIN_WIDTH_LINES);
      const h = wrap(label.text, w, label.font, label.size).length * label.lineHeight;
      lf = { x: textRect.x + textRect.w / 2 - w / 2, y: textRect.y + textRect.h / 2 - h / 2, w, h };
    }
    labelDraw = placed(label, lf, toPage(pt(lf.x + lf.w / 2, lf.y + lf.h / 2), box, rotation), rotation);
  }
  if (rotation !== 0) paths = paths.map((p) => mapPath(p, (q) => toPage(q, box, rotation)));
  return { kindId: kind.id, paths, label: labelDraw };
}

/** A point of the unturned frame on the page: turned [rotation] about the box centre. */
function toPage(p: Pt, box: Rect, rotation: number): Pt {
  if (rotation === 0) return p;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const cs = Math.cos(rotation), sn = Math.sin(rotation);
  return pt(cx + (p.x - cx) * cs - (p.y - cy) * sn, cy + (p.x - cx) * sn + (p.y - cy) * cs);
}

/** Every point a shape draws through (for bounds and selection), curves flattened. */
export function shapePolylines(paths: ShapePath[]): { pts: Pt[]; closed: boolean }[] {
  return paths.flatMap((p) => p.contours.map((c) => ({ pts: flatten(c), closed: c.closed })));
}

/** The four page corners of a turned label. */
export function labelCorners(l: LabelDraw): Pt[] {
  const cs = Math.cos(l.rotation), sn = Math.sin(l.rotation);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * l.w) / 2, y = (sy * l.h) / 2;
    return pt(l.cx + x * cs - y * sn, l.cy + x * sn + y * cs);
  });
}
