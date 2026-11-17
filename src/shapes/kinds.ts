// Ported from XNotes core/shapes/ShapeKind.kt, BasicKinds.kt, FlowchartKinds.kt, ArrowKinds.kt and SolidMathKinds.kt (MIT, Shardul Vikram Singh).
import * as FreePath from "./freePath";
import { headLength, headPaths } from "./head";
import {
  KAPPA,
  bounding,
  clamp,
  ellipseContour,
  ellipsePath,
  inset,
  lines,
  mapPath,
  polygonPath,
  polylinePath,
  pt,
  rect,
  rectFromPoints,
  rectPath,
  vadd,
  vdist,
  vlen,
  vnorm,
  vperp,
  vscale,
  vsub,
  type Contour,
  type Head,
  type PathRole,
  type Pt,
  type Rect,
  type Seg,
  type ShapeGeometry,
  type ShapeKind,
  type ShapeParams,
  type ShapePath,
} from "./types";

// --- shared helpers ---

const right = (b: Rect): number => b.x + b.w;
const bottom = (b: Rect): number => b.y + b.h;
const cx = (b: Rect): number => b.x + b.w / 2;
const cy = (b: Rect): number => b.y + b.h / 2;
const center = (b: Rect): Pt => pt(cx(b), cy(b));
const topLeft = (b: Rect): Pt => pt(b.x, b.y);
const rad = (deg: number): number => deg * (Math.PI / 180);

/** ShapePath's constructor: role and fill rule default to OUTLINE, nonzero. */
const sp = (contours: Contour[], role: PathRole = "OUTLINE", fillRule: ShapePath["fillRule"] = "nonzero"): ShapePath => ({ contours, role, fillRule });
const geom = (paths: ShapePath[], textRect: Rect): ShapeGeometry => ({ paths, textRect });
const L = (end: Pt): Seg => ({ t: "L", end });
const C = (c1: Pt, c2: Pt, end: Pt): Seg => ({ t: "C", c1, c2, end });
const contour = (start: Pt, segs: Seg[], closed: boolean): Contour => ({ start, segs, closed });
const segment = (a: Pt, b: Pt): Contour => lines([a, b], false);

/** Knob value [i] out of [adj], falling back to the default for one a file left out. */
export function adjOf(kind: ShapeKind, adj: number[], i: number): number {
  const v = adj[i];
  return v !== undefined && Number.isFinite(v) ? v : kind.defaultAdj[i];
}

interface KindOptions {
  closed: boolean;
  endpoint?: boolean;
  free?: boolean;
  adj?: number[];
  n?: number;
  headEnd?: Head;
}

type Builder = (box: Rect, p: ShapeParams, adj: (i: number) => number) => ShapeGeometry;

function makeKind(id: string, o: KindOptions, build: Builder): ShapeKind {
  const k: ShapeKind = {
    id,
    isClosed: o.closed,
    isEndpointShape: o.endpoint ?? false,
    isFree: o.free ?? false,
    defaultAdj: o.adj ?? [],
    defaultN: o.n ?? 0,
    defaultHeadStart: "none",
    defaultHeadEnd: o.headEnd ?? "none",
    build: (box, p) => build(box, p, (i) => adjOf(k, p.adj, i)),
  };
  return k;
}

/** An elliptical arc as cubics of a quarter turn or less: [start] and [sweep] in radians, clockwise on screen. */
export function arcSegments(c: Pt, rx: number, ry: number, start: number, sweep: number): Seg[] {
  const pieces = Math.max(1, Math.trunc(Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)));
  const step = sweep / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Seg[] = [];
  const place = (u: Pt): Pt => pt(c.x + rx * u.x, c.y + ry * u.y);
  let a = start;
  for (let i = 0; i < pieces; i++) {
    const b = a + step;
    const p0 = pt(Math.cos(a), Math.sin(a));
    const p3 = pt(Math.cos(b), Math.sin(b));
    const c1 = vadd(p0, vscale(pt(-Math.sin(a), Math.cos(a)), k));
    const c2 = vsub(p3, vscale(pt(-Math.sin(b), Math.cos(b)), k));
    out.push(C(place(c1), place(c2), place(p3)));
    a = b;
  }
  return out;
}

/** [box] as a closed contour with corners rounded to [r], clockwise from the end of the top-left curve. */
export function roundedRect(box: Rect, r: number): Contour {
  const rr = clamp(r, 0, Math.min(box.w, box.h) / 2);
  const l = box.x;
  const t = box.y;
  const rt = right(box);
  const b = bottom(box);
  if (rr <= 1e-9) return lines([topLeft(box), pt(rt, t), pt(rt, b), pt(l, b)], true);
  const k = rr * KAPPA;
  return contour(
    pt(l + rr, t),
    [
      L(pt(rt - rr, t)),
      C(pt(rt - rr + k, t), pt(rt, t + rr - k), pt(rt, t + rr)),
      L(pt(rt, b - rr)),
      C(pt(rt, b - rr + k), pt(rt - rr + k, b), pt(rt - rr, b)),
      L(pt(l + rr, b)),
      C(pt(l + rr - k, b), pt(l, b - rr + k), pt(l, b - rr)),
      L(pt(l, t + rr)),
      C(pt(l, t + rr - k), pt(l + rr - k, t), pt(l + rr, t)),
    ],
    true,
  );
}

const rectCorners = (b: Rect): Pt[] => [topLeft(b), pt(right(b), b.y), pt(right(b), bottom(b)), pt(b.x, bottom(b))];

// --- ShapeKind.kt ---

const endpointKind = (id: string, headEnd: Head): ShapeKind =>
  makeKind(id, { closed: false, endpoint: true, headEnd }, (box) => geom([polylinePath([topLeft(box), pt(right(box), bottom(box))])], box));

const rectangleKind = (id: string): ShapeKind => makeKind(id, { closed: true }, (box) => geom([polygonPath(rectCorners(box))], inset(box)));

const ellipseKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true }, (box) => {
    const rx = box.w / 2;
    const ry = box.h / 2;
    // The biggest box inside an ellipse is the one inscribed at 45 degrees.
    const k = 1 / Math.sqrt(2);
    return geom([ellipsePath(cx(box), cy(box), rx, ry)], rect(cx(box) - rx * k, cy(box) - ry * k, 2 * rx * k, 2 * ry * k));
  });

const triangleKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, adj: [0.5] }, (box, _p, adj) => {
    const apex = pt(box.x + box.w * adj(0), box.y);
    const corners = [apex, pt(right(box), bottom(box)), pt(box.x, bottom(box))];
    return geom([polygonPath(corners)], rect(box.x + box.w / 4, box.y + box.h / 2, box.w / 2, box.h / 2));
  });

const glyphsKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, free: true }, (box, p) => geom([sp(FreePath.place(p.path ?? [], box), "FILL_ONLY", "nonzero")], box));

const fillKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, free: true }, (box, p) => geom([sp(FreePath.place(p.path ?? [], box), "FILL_ONLY", "evenodd")], box));

const freeKind = (id: string, closed: boolean): ShapeKind =>
  makeKind(id, { closed, free: true }, (box, p) => geom([sp(FreePath.place(p.path ?? [], box), closed ? "OUTLINE" : "STROKE_ONLY")], inset(box)));

// --- BasicKinds.kt ---

const roundedRectKind = (id: string, capsule: boolean): ShapeKind =>
  makeKind(id, { closed: true, adj: capsule ? [] : [1 / 6] }, (box, _p, adj) => {
    const r = capsule ? Math.min(box.w, box.h) / 2 : Math.min(box.w, box.h) * clamp(adj(0), 0, 0.5);
    const d = r * (1 - 1 / Math.sqrt(2));
    const text = rect(box.x + d, box.y + d, Math.max(0, box.w - 2 * d), Math.max(0, box.h - 2 * d));
    return geom([sp([roundedRect(box, r)])], inset(text));
  });

const rightTriangleKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true }, (box) =>
    geom([polygonPath([topLeft(box), pt(right(box), bottom(box)), pt(box.x, bottom(box))])], inset(rect(box.x, box.y + box.h / 2, box.w / 2, box.h / 2))),
  );

const diamondKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true }, (box) =>
    geom(
      [polygonPath([pt(cx(box), box.y), pt(right(box), cy(box)), pt(cx(box), bottom(box)), pt(box.x, cy(box))])],
      rect(box.x + box.w / 4, box.y + box.h / 4, box.w / 2, box.h / 2),
    ),
  );

const parallelogramKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, adj: [0.25] }, (box, _p, adj) => {
    const s = box.w * clamp(adj(0), 0, 0.9);
    const corners = [pt(box.x + s, box.y), pt(right(box), box.y), pt(right(box) - s, bottom(box)), pt(box.x, bottom(box))];
    return geom([polygonPath(corners)], inset(rect(box.x + s / 2, box.y, Math.max(0, box.w - s), box.h)));
  });

const trapezoidKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, adj: [0.25] }, (box, _p, adj) => {
    const i = box.w * clamp(adj(0), 0, 0.5);
    const corners = [pt(box.x + i, box.y), pt(right(box) - i, box.y), pt(right(box), bottom(box)), pt(box.x, bottom(box))];
    return geom([polygonPath(corners)], inset(rect(box.x + i / 2, box.y, Math.max(0, box.w - i), box.h)));
  });

/** A point on the unit circle at angle [a], at radius [r]. */
const unitPoint = (a: number, r: number): Pt => pt(r * Math.cos(a), r * Math.sin(a));

/** The corners of a regular [n]-gon on the unit circle, the first straight up. */
const regularUnit = (n: number): Pt[] => Array.from({ length: n }, (_, k) => unitPoint(-Math.PI / 2 + (2 * Math.PI * k) / n, 1));

/** [unit] points stretched so that [by] (default: the points themselves) exactly fill [box]. */
function fitToBox(unit: Pt[], box: Rect, by: Pt[] = unit): Pt[] {
  const b = bounding(by);
  const sx = b.w > 0 ? box.w / b.w : 0;
  const sy = b.h > 0 ? box.h / b.h : 0;
  return unit.map((u) => pt(box.x + (u.x - b.x) * sx, box.y + (u.y - b.y) * sy));
}

const regularPolygonKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, n: 5 }, (box, p) => geom([polygonPath(fitToBox(regularUnit(clamp(p.n, 3, 24)), box))], inset(box, 0.18)));

const starKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, n: 5, adj: [-1] }, (box, p, adj) => {
    const n = clamp(p.n, 3, 24);
    // The inner radius's share: the knob's, or the classic star for [n] points.
    let k = adj(0);
    if (!(k > 0)) k = n >= 5 ? Math.cos((2 * Math.PI) / n) / Math.cos(Math.PI / n) : 0.38;
    const unit = Array.from({ length: 2 * n }, (_, i) => unitPoint(-Math.PI / 2 + (Math.PI * i) / n, i % 2 === 0 ? 1 : k));
    // Fitted by the outer points alone, which is where the star meets its box.
    const corners = fitToBox(unit, box, regularUnit(n));
    const c = center(box);
    const s = 0.5 * k;
    return geom([polygonPath(corners)], rect(c.x - (box.w * s) / 2, c.y - (box.h * s) / 2, box.w * s, box.h * s));
  });

const crossKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, adj: [1 / 3] }, (box, _p, adj) => {
    const h = (Math.min(box.w, box.h) * clamp(adj(0), 0.05, 1)) / 2;
    const x = cx(box);
    const y = cy(box);
    const r = right(box);
    const b = bottom(box);
    const corners = [
      pt(x - h, box.y), pt(x + h, box.y), pt(x + h, y - h), pt(r, y - h),
      pt(r, y + h), pt(x + h, y + h), pt(x + h, b), pt(x - h, b),
      pt(x - h, y + h), pt(box.x, y + h), pt(box.x, y - h), pt(x - h, y - h),
    ];
    return geom([polygonPath(corners)], rect(x - h, y - h, 2 * h, 2 * h));
  });

const heartKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true }, (box) => {
    const at = (x: number, y: number): Pt => pt(box.x + x * box.w, box.y + y * box.h);
    const c = contour(
      at(0.5, 0.22),
      [
        C(at(0.5, 0.08), at(0.38, 0), at(0.25, 0)),
        C(at(0.1, 0), at(0, 0.12), at(0, 0.3)),
        C(at(0, 0.55), at(0.25, 0.75), at(0.5, 1)),
        C(at(0.75, 0.75), at(1, 0.55), at(1, 0.3)),
        C(at(1, 0.12), at(0.9, 0), at(0.75, 0)),
        C(at(0.62, 0), at(0.5, 0.08), at(0.5, 0.22)),
      ],
      true,
    );
    return geom([sp([c])], rect(box.x + 0.2 * box.w, box.y + 0.25 * box.h, 0.6 * box.w, 0.4 * box.h));
  });

const cloudKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true }, (box) => {
    // Uneven steps round the oval, so the bumps read as a cloud rather than a gear.
    const turns = [0.0, 0.11, 0.24, 0.36, 0.47, 0.6, 0.71, 0.83, 0.93];
    const base = turns.map((t) => {
      const a = 2 * Math.PI * t - Math.PI / 2;
      return pt(Math.cos(a), Math.sin(a));
    });
    const segs: Seg[] = base.map((a, i) => {
      const b = base[(i + 1) % base.length];
      // Each bump bulges out along the radius at both of its feet.
      const lift = vdist(a, b) * 0.62;
      return C(vadd(a, vscale(a, lift)), vadd(b, vscale(b, lift)), b);
    });
    const unit = contour(base[0], segs, true);
    const tight = FreePath.bounds([unit]) ?? rect(-1, -1, 2, 2);
    const placed = FreePath.place(FreePath.normalize([unit], tight), box)[0];
    return geom([sp([placed])], inset(box, 0.2));
  });

const ringKind = (id: string): ShapeKind =>
  makeKind(id, { closed: true, adj: [0.25] }, (box, _p, adj) => {
    const t = clamp(adj(0), 0.02, 0.98);
    const rx = box.w / 2;
    const ry = box.h / 2;
    const inner = 1 - t;
    const path = sp([ellipseContour(cx(box), cy(box), rx, ry), ellipseContour(cx(box), cy(box), rx * inner, ry * inner)], "OUTLINE", "evenodd");
    const k = inner / Math.sqrt(2);
    return geom([path], rect(cx(box) - rx * k, cy(box) - ry * k, 2 * rx * k, 2 * ry * k));
  });

const sliceKind = (id: string, pie: boolean): ShapeKind =>
  makeKind(id, { closed: pie, adj: pie ? [0, 270] : [270, 0] }, (box, _p, adj) => {
    const norm = (d: number): number => {
      const r = d % 360;
      return r < 0 ? r + 360 : r;
    };
    const onRim = (d: number): Pt => pt(cx(box) + (box.w / 2) * Math.cos(rad(d)), cy(box) + (box.h / 2) * Math.sin(rad(d)));
    const a0 = adj(0);
    const a1 = adj(1);
    let sweep = norm(a1 - a0);
    if (sweep < 1e-9) sweep = 360;
    const c = center(box);
    const arc = arcSegments(c, box.w / 2, box.h / 2, rad(a0), rad(sweep));
    const from = onRim(a0);
    const c0 = pie ? contour(c, [L(from), ...arc, L(c)], true) : contour(from, arc, false);
    return geom([sp([c0], pie ? "OUTLINE" : "STROKE_ONLY")], inset(box, 0.25));
  });

// --- FlowchartKinds.kt ---

const flowPolygonKind = (id: string, text: (b: Rect) => Rect, corners: (b: Rect) => Pt[]): ShapeKind =>
  makeKind(id, { closed: true }, (box) => geom([polygonPath(corners(box))], text(box)));

const flowDetailKind = (id: string, text: (b: Rect) => Rect, outline: (b: Rect) => Contour, detail: (b: Rect) => Contour[]): ShapeKind =>
  makeKind(id, { closed: true }, (box) => geom([sp([outline(box)]), sp(detail(box), "STROKE_ONLY")], text(box)));

function flowCurvedKind(
  id: string,
  text: (b: Rect) => Rect,
  contours: (b: Rect) => Contour[],
  detail: (b: Rect) => Contour[] = () => [],
  stacked = false,
): ShapeKind {
  return makeKind(id, { closed: true }, (box) => {
    const main = contours(box);
    const paths: ShapePath[] = [];
    // A stack draws its back pages as bare edges, so they never show through the front page.
    if (stacked) paths.push(sp(main.slice(0, -1), "STROKE_ONLY"), sp(main.slice(-1)));
    else paths.push(sp(main.slice(0, 1)));
    const d = detail(box);
    if (d.length) paths.push(sp(d, "STROKE_ONLY"));
    return geom(paths, text(box));
  });
}

const rectContour = (b: Rect): Contour => lines(rectCorners(b), true);

/** The document symbol: square top, a wave along the bottom that dips on the left and rises on the right. */
function documentContour(b: Rect): Contour {
  const a = b.h * 0.08;
  const base = bottom(b) - a;
  // Handles this far out make the wave's lowest point land exactly on the box's bottom edge.
  const reach = 2 * a * Math.sqrt(3);
  return contour(
    topLeft(b),
    [L(pt(right(b), b.y)), L(pt(right(b), base)), C(pt(right(b) - b.w / 3, base - reach), pt(b.x + b.w / 3, base + reach), pt(b.x, base))],
    true,
  );
}

const arcTo = (c: Pt, rx: number, ry: number, startDeg: number, sweepDeg: number): Seg[] => arcSegments(c, rx, ry, rad(startDeg), rad(sweepDeg));

/** A database's cap: never more than a quarter of its height or a fifth of its width's worth. */
const cap = (b: Rect): number => Math.min(0.25 * b.h, 0.4 * b.w);
/** A drum's end: never more than a quarter of its width or most of its height. */
const side = (b: Rect): number => Math.min(0.25 * b.w, 0.8 * b.h);
const delayRadius = (b: Rect): number => Math.min(b.h / 2, b.w);

const FLOWCHART_KINDS: ShapeKind[] = [
  makeKind("flow_preparation", { closed: true, adj: [0.2] }, (box, _p, adj) => {
    const i = box.w * clamp(adj(0), 0, 0.5);
    const c = [
      pt(box.x + i, box.y), pt(right(box) - i, box.y), pt(right(box), cy(box)),
      pt(right(box) - i, bottom(box)), pt(box.x + i, bottom(box)), pt(box.x, cy(box)),
    ];
    return geom([polygonPath(c)], inset(rect(box.x + i / 2, box.y, Math.max(0, box.w - i), box.h)));
  }),
  flowDetailKind(
    "flow_predefined",
    (b) => inset(rect(b.x + 0.1 * b.w, b.y, 0.8 * b.w, b.h)),
    rectContour,
    (b) => [segment(pt(b.x + 0.1 * b.w, b.y), pt(b.x + 0.1 * b.w, bottom(b))), segment(pt(right(b) - 0.1 * b.w, b.y), pt(right(b) - 0.1 * b.w, bottom(b)))],
  ),
  flowDetailKind(
    "flow_internal_storage",
    (b) => inset(rect(b.x + 0.15 * b.w, b.y + 0.15 * b.h, 0.85 * b.w, 0.85 * b.h)),
    rectContour,
    (b) => [segment(pt(b.x + 0.15 * b.w, b.y), pt(b.x + 0.15 * b.w, bottom(b))), segment(pt(b.x, b.y + 0.15 * b.h), pt(right(b), b.y + 0.15 * b.h))],
  ),
  flowCurvedKind("flow_document", (b) => inset(rect(b.x, b.y, b.w, 0.82 * b.h)), (b) => [documentContour(b)]),
  flowCurvedKind(
    "flow_multidocument",
    (b) => inset(rect(b.x, b.y + 0.2 * b.h, 0.8 * b.w, 0.65 * b.h)),
    (b) => {
      const d = Math.min(b.w, b.h) * 0.1;
      const back = rect(b.x + 2 * d, b.y, b.w - 2 * d, b.h - 2 * d);
      const middle = rect(b.x + d, b.y + d, b.w - 2 * d, b.h - 2 * d);
      const front = rect(b.x, b.y + 2 * d, b.w - 2 * d, b.h - 2 * d);
      const wave = 0.08 * front.h;
      // Each page behind shows its top and its right edge, tucked under the page in front.
      return [
        lines([pt(back.x, middle.y), topLeft(back), pt(right(back), back.y), pt(right(back), bottom(back) - wave), pt(right(middle), bottom(back) - wave)], false),
        lines([pt(middle.x, front.y), topLeft(middle), pt(right(middle), middle.y), pt(right(middle), bottom(middle) - wave), pt(right(front), bottom(middle) - wave)], false),
        documentContour(front),
      ];
    },
    () => [],
    true,
  ),
  flowPolygonKind(
    "flow_manual_input",
    (b) => inset(rect(b.x, b.y + 0.25 * b.h, b.w, 0.75 * b.h)),
    (b) => [pt(b.x, b.y + 0.25 * b.h), pt(right(b), b.y), pt(right(b), bottom(b)), pt(b.x, bottom(b))],
  ),
  flowPolygonKind(
    "flow_manual_operation",
    (b) => inset(rect(b.x + 0.1 * b.w, b.y, 0.8 * b.w, b.h)),
    (b) => [topLeft(b), pt(right(b), b.y), pt(right(b) - 0.2 * b.w, bottom(b)), pt(b.x + 0.2 * b.w, bottom(b))],
  ),
  flowPolygonKind(
    "flow_off_page",
    (b) => inset(rect(b.x, b.y, b.w, 0.75 * b.h)),
    (b) => [topLeft(b), pt(right(b), b.y), pt(right(b), b.y + 0.75 * b.h), pt(cx(b), bottom(b)), pt(b.x, b.y + 0.75 * b.h)],
  ),
  flowPolygonKind("flow_merge", (b) => rect(b.x + b.w / 4, b.y, b.w / 2, b.h / 2), (b) => [topLeft(b), pt(right(b), b.y), pt(cx(b), bottom(b))]),
  flowCurvedKind(
    "flow_database",
    (b) => inset(rect(b.x, b.y + cap(b), b.w, b.h - 1.5 * cap(b))),
    (b) => {
      const c = cap(b);
      const top = pt(cx(b), b.y + c / 2);
      const bot = pt(cx(b), bottom(b) - c / 2);
      return [contour(pt(b.x, top.y), [...arcTo(top, b.w / 2, c / 2, 180, 180), L(pt(right(b), bot.y)), ...arcTo(bot, b.w / 2, c / 2, 0, 180)], true)];
    },
    (b) => {
      const c = cap(b);
      const top = pt(cx(b), b.y + c / 2);
      return [contour(pt(right(b), top.y), arcTo(top, b.w / 2, c / 2, 0, 180), false)];
    },
  ),
  flowCurvedKind(
    "flow_direct_access",
    (b) => inset(rect(b.x + side(b) / 2, b.y, b.w - 1.5 * side(b), b.h)),
    (b) => {
      const c = side(b);
      const left = pt(b.x + c / 2, cy(b));
      const rt = pt(right(b) - c / 2, cy(b));
      return [
        contour(
          pt(left.x, b.y),
          [L(pt(rt.x, b.y)), ...arcTo(rt, c / 2, b.h / 2, -90, 180), L(pt(left.x, bottom(b))), ...arcTo(left, c / 2, b.h / 2, 90, 180)],
          true,
        ),
      ];
    },
    (b) => {
      const c = side(b);
      const rt = pt(right(b) - c / 2, cy(b));
      return [contour(pt(rt.x, b.y), arcTo(rt, c / 2, b.h / 2, -90, -180), false)];
    },
  ),
  flowCurvedKind(
    "flow_display",
    (b) => inset(rect(b.x + 0.15 * b.w, b.y, 0.7 * b.w, b.h)),
    (b) => {
      const r = 0.15 * b.w;
      const c = pt(right(b) - r, cy(b));
      return [
        contour(
          pt(b.x, cy(b)),
          [L(pt(b.x + 0.15 * b.w, b.y)), L(pt(c.x, b.y)), ...arcTo(c, r, b.h / 2, -90, 180), L(pt(b.x + 0.15 * b.w, bottom(b)))],
          true,
        ),
      ];
    },
  ),
  flowCurvedKind(
    "flow_delay",
    (b) => inset(rect(b.x, b.y, b.w - delayRadius(b) / 2, b.h)),
    (b) => {
      const r = delayRadius(b);
      const c = pt(right(b) - r, cy(b));
      return [contour(topLeft(b), [L(pt(c.x, b.y)), ...arcTo(c, r, b.h / 2, -90, 180), L(pt(b.x, bottom(b)))], true)];
    },
  ),
  flowCurvedKind(
    "flow_stored_data",
    (b) => inset(rect(b.x + 0.12 * b.w, b.y, 0.76 * b.w, b.h)),
    (b) => {
      const k = 0.12 * b.w;
      return [
        contour(
          pt(b.x + k, b.y),
          [L(pt(right(b), b.y)), ...arcTo(pt(right(b), cy(b)), k, b.h / 2, -90, -180), L(pt(b.x + k, bottom(b))), ...arcTo(pt(b.x + k, cy(b)), k, b.h / 2, 90, 180)],
          true,
        ),
      ];
    },
  ),
  flowDetailKind(
    "flow_sort",
    (b) => rect(b.x + b.w / 4, b.y + b.h / 4, b.w / 2, b.h / 2),
    (b) => lines([pt(cx(b), b.y), pt(right(b), cy(b)), pt(cx(b), bottom(b)), pt(b.x, cy(b))], true),
    (b) => [segment(pt(b.x, cy(b)), pt(right(b), cy(b)))],
  ),
  flowDetailKind(
    "flow_summing",
    (b) => inset(b, 0.3),
    (b) => ellipseContour(cx(b), cy(b), b.w / 2, b.h / 2),
    (b) => {
      const on = (d: number): Pt => pt(cx(b) + (b.w / 2) * Math.cos(rad(d)), cy(b) + (b.h / 2) * Math.sin(rad(d)));
      return [segment(on(45), on(225)), segment(on(135), on(315))];
    },
  ),
  flowDetailKind(
    "flow_or",
    (b) => inset(b, 0.3),
    (b) => ellipseContour(cx(b), cy(b), b.w / 2, b.h / 2),
    (b) => [segment(pt(cx(b), b.y), pt(cx(b), bottom(b))), segment(pt(b.x, cy(b)), pt(right(b), cy(b)))],
  ),
];

// --- ArrowKinds.kt ---

/** Which way a canonical, right-pointing drawing is laid onto its box. */
type Orient = "RIGHT" | "LEFT" | "UP" | "DOWN";

/** The canonical box's width and height for a real box [b]: turned ones swap them. */
const canonicalSize = (o: Orient, b: Rect): [number, number] => (o === "UP" || o === "DOWN" ? [b.h, b.w] : [b.w, b.h]);

function orientMap(o: Orient, p: Pt, b: Rect): Pt {
  switch (o) {
    case "RIGHT":
      return pt(b.x + p.x, b.y + p.y);
    case "LEFT":
      return pt(right(b) - p.x, b.y + p.y);
    case "UP":
      return pt(b.x + p.y, bottom(b) - p.x);
    case "DOWN":
      return pt(right(b) - p.y, b.y + p.x);
  }
}

/** A drawing made in the canonical box (0, 0)-([w], [h]), pointing right. */
interface Canonical {
  defaultAdj: number[];
  build(w: number, h: number, adj: (i: number) => number): ShapeGeometry;
}

/** A [Canonical] drawing laid onto its box by [orient]. */
const orientedKind = (id: string, orient: Orient, drawing: Canonical): ShapeKind =>
  makeKind(id, { closed: true, adj: drawing.defaultAdj }, (box, _p, adj) => {
    const [w, h] = canonicalSize(orient, box);
    const g = drawing.build(w, h, adj);
    const f = (q: Pt): Pt => orientMap(orient, q, box);
    const t = g.textRect;
    return geom(
      g.paths.map((p) => mapPath(p, f)),
      rectFromPoints(f(topLeft(t)), f(pt(right(t), bottom(t)))),
    );
  });

/** A kind drawn straight into its box, for the arrows with no direction and for the callouts. */
const boxedKind = (id: string, drawing: Canonical): ShapeKind =>
  makeKind(id, { closed: true, adj: drawing.defaultAdj }, (box, _p, adj) => {
    const g = drawing.build(box.w, box.h, adj);
    const f = (q: Pt): Pt => pt(q.x + box.x, q.y + box.y);
    return geom(
      g.paths.map((p) => mapPath(p, f)),
      rect(g.textRect.x + box.x, g.textRect.y + box.y, g.textRect.w, g.textRect.h),
    );
  });

/** A shaft's thickness from its stored [share] of the shorter side, held to [lo]..[hi]. */
const thickness = (share: number, w: number, h: number, lo: number, hi: number): number => clamp(share, lo, hi) * Math.min(w, h);

/** One head on the right of a straight shaft. Notched: a V cut into the tail. */
const singleArrow = (notched: boolean): Canonical => ({
  defaultAdj: [],
  build(w, h) {
    const l = Math.min(h / 2, w);
    const half = h / 4;
    const y = h / 2;
    const notch = notched ? Math.min(half, w - l) : 0;
    const corners = [
      pt(0, y - half), pt(w - l, y - half), pt(w - l, 0), pt(w, y),
      pt(w - l, h), pt(w - l, y + half), pt(0, y + half),
      ...(notched ? [pt(notch, y)] : []),
    ];
    return geom([polygonPath(corners)], rect(notch, y - half, Math.max(0, w - l - notch), 2 * half));
  },
});

/** Heads at both ends of a straight shaft. */
const doubleArrow: Canonical = {
  defaultAdj: [],
  build(w, h) {
    const l = Math.min(h / 2, w / 2);
    const half = h / 4;
    const y = h / 2;
    const corners = [
      pt(0, y), pt(l, 0), pt(l, y - half), pt(w - l, y - half), pt(w - l, 0), pt(w, y),
      pt(w - l, h), pt(w - l, y + half), pt(l, y + half), pt(l, h),
    ];
    return geom([polygonPath(corners)], rect(l, y - half, Math.max(0, w - 2 * l), 2 * half));
  },
};

/** Four heads, one on each side, their shafts crossing in the middle. */
const quadArrow: Canonical = {
  defaultAdj: [0.22],
  build(w, h, adj) {
    // At a third of the shorter side the heads' bases meet the crossing.
    const t = thickness(adj(0), w, h, 0.05, 1 / 3);
    const a = t / 2;
    const b = t;
    const l = t;
    const x = w / 2;
    const y = h / 2;
    const c = [
      pt(x, 0), pt(x + b, l), pt(x + a, l), pt(x + a, y - a), pt(w - l, y - a), pt(w - l, y - b),
      pt(w, y), pt(w - l, y + b), pt(w - l, y + a), pt(x + a, y + a), pt(x + a, h - l), pt(x + b, h - l),
      pt(x, h), pt(x - b, h - l), pt(x - a, h - l), pt(x - a, y + a), pt(l, y + a), pt(l, y + b),
      pt(0, y), pt(l, y - b), pt(l, y - a), pt(x - a, y - a), pt(x - a, l), pt(x - b, l),
    ];
    return geom([polygonPath(c)], rect(x - a, y - a, 2 * a, 2 * a));
  },
};

/** A chevron (notched both ends) or a pentagon arrow (square tail), the knob setting how far the point reaches back. */
const pointedBand = (notchedTail: boolean): Canonical => ({
  defaultAdj: [0.5],
  build(w, h, adj) {
    const d = clamp(adj(0) * Math.min(w, h), 0, notchedTail ? w / 2 : w);
    const y = h / 2;
    const c = [pt(0, 0), pt(w - d, 0), pt(w, y), pt(w - d, h), pt(0, h), ...(notchedTail ? [pt(d, y)] : [])];
    const tail = notchedTail ? d : 0;
    return geom([polygonPath(c)], inset(rect(tail, 0, w - d - tail, h)));
  },
});

/** An L: a shaft up the left side turning right along the top into a head. Bent-up: along the bottom, turning up at the right. */
const bentArrow = (up: boolean): Canonical => ({
  defaultAdj: [0.25],
  build(w, h, adj) {
    const t = thickness(adj(0), w, h, 0.05, 0.45);
    const b = t;
    const l = clamp(t, 0, Math.max(0, (up ? h : w) - t));
    let c: Pt[];
    if (!up) {
      c = [
        pt(0, h), pt(0, b - t / 2), pt(w - l, b - t / 2), pt(w - l, 0), pt(w, b),
        pt(w - l, 2 * b), pt(w - l, b + t / 2), pt(t, b + t / 2), pt(t, h),
      ];
    } else {
      const x = w - b;
      c = [
        pt(0, h - t), pt(x - t / 2, h - t), pt(x - t / 2, l), pt(w - 2 * b, l), pt(x, 0),
        pt(w, l), pt(x + t / 2, l), pt(x + t / 2, h), pt(0, h),
      ];
    }
    const text = !up ? rect(t, b + t / 2, w - t, h - b - t / 2) : rect(0, 0, w - 2 * b, h - t);
    return geom([polygonPath(c)], inset(text));
  },
});

/** Two heads joined by an L: one pointing left at the bottom, one pointing up at the right. */
const leftUpArrow: Canonical = {
  defaultAdj: [0.2],
  build(w, h, adj) {
    const t = thickness(adj(0), w, h, 0.05, 0.3);
    const b = t;
    const l = clamp(t, 0, Math.min(w, h) / 2);
    const x = w - b;
    const y = h - b;
    const c = [
      pt(0, y), pt(l, y - b), pt(l, y - t / 2), pt(x - t / 2, y - t / 2), pt(x - t / 2, l),
      pt(x - b, l), pt(x, 0), pt(w, l), pt(x + t / 2, l), pt(x + t / 2, y + t / 2),
      pt(l, y + t / 2), pt(l, h),
    ];
    return geom([polygonPath(c)], inset(rect(0, 0, x - t / 2, y - t / 2)));
  },
};

/** A U: up the left, over the top in a half circle, down the right into a head pointing down. */
const uTurnArrow: Canonical = {
  defaultAdj: [0.25],
  build(w, h, adj) {
    const t = thickness(adj(0), w, h, 0.05, 0.3);
    const b = t;
    const l = clamp(t, 0, h / 2);
    const leftX = t / 2;
    const rightX = w - b;
    const rc = (rightX - leftX) / 2;
    const outer = rc + t / 2;
    const inner = Math.max(rc - t / 2, 1e-6);
    // A shallow box flattens the bend into a half ellipse rather than overrunning the legs.
    const outerY = Math.max(Math.min(outer, (h - l) * 0.7), t);
    const innerY = Math.max(outerY - t, 1e-6);
    const centre = pt((leftX + rightX) / 2, outerY);
    const segs: Seg[] = [
      L(pt(0, centre.y)),
      ...arcSegments(centre, outer, outerY, Math.PI, Math.PI),
      L(pt(rightX + t / 2, h - l)),
      L(pt(w, h - l)),
      L(pt(rightX, h)),
      L(pt(w - 2 * b, h - l)),
      L(pt(rightX - t / 2, h - l)),
      L(pt(rightX - t / 2, centre.y)),
      ...arcSegments(centre, inner, innerY, 0, -Math.PI),
      L(pt(t, h)),
    ];
    return geom([sp([contour(pt(0, h), segs, true)])], inset(rect(t, centre.y, w - 2 * b - t, h - centre.y - l)));
  },
};

/** A band sweeping up from the bottom left in a quarter curve into a head pointing right at the top. */
const curvedArrow: Canonical = {
  defaultAdj: [0.25],
  build(w, h, adj) {
    const t = thickness(adj(0), w, h, 0.05, 0.4);
    const b = t;
    const l = clamp(t, 0, w / 2);
    const centre = pt(w - l, h);
    const rx = Math.max(w - l - t / 2, t);
    const ry = Math.max(h - b, t);
    const segs: Seg[] = [
      ...arcSegments(centre, rx + t / 2, ry + t / 2, Math.PI, Math.PI / 2),
      L(pt(w - l, 0)),
      L(pt(w, b)),
      L(pt(w - l, 2 * b)),
      L(pt(w - l, b + t / 2)),
      ...arcSegments(centre, rx - t / 2, ry - t / 2, 1.5 * Math.PI, -Math.PI / 2),
    ];
    return geom([sp([contour(pt(centre.x - rx - t / 2, h), segs, true)])], inset(rect(t, 2 * b, w - l - t, h - 2 * b)));
  },
};

/** Three quarters of a ring, clockwise from the bottom left, ending in a head. */
const circularArrow: Canonical = {
  defaultAdj: [0.25],
  build(w, h, adj) {
    const START = 0.75 * Math.PI;
    const SWEEP = 1.5 * Math.PI;
    const b = rect(0, 0, w, h);
    const onUnit = (a: number, r: number): Pt => pt(cx(b) + (b.w / 2) * r * Math.cos(a), cy(b) + (b.h / 2) * r * Math.sin(a));
    const t = clamp(adj(0), 0.05, 0.4);
    const mid = 1 - t;
    const half = t / 2;
    const end = START + SWEEP;
    const tipAngle = end + t / mid;
    const segs: Seg[] = [
      ...arcSegments(center(b), (w / 2) * (mid + half), (h / 2) * (mid + half), START, SWEEP),
      L(onUnit(end, mid + t)),
      L(onUnit(tipAngle, mid)),
      L(onUnit(end, mid - t)),
      L(onUnit(end, mid - half)),
      ...arcSegments(center(b), (w / 2) * (mid - half), (h / 2) * (mid - half), end, -SWEEP),
    ];
    return geom([sp([contour(onUnit(START, mid + half), segs, true)])], inset(b, 0.32));
  },
};

/** A right arrow whose tail is broken into two stripes. */
const stripedArrow: Canonical = {
  defaultAdj: [],
  build(w, h) {
    const l = Math.min(h / 2, w * 0.7);
    const half = h / 4;
    const y = h / 2;
    const s = w * 0.05;
    const bar = (x: number, width: number): Contour => lines([pt(x, y - half), pt(x + width, y - half), pt(x + width, y + half), pt(x, y + half)], true);
    const body = [pt(4 * s, y - half), pt(w - l, y - half), pt(w - l, 0), pt(w, y), pt(w - l, h), pt(w - l, y + half), pt(4 * s, y + half)];
    return geom([sp([bar(0, s), bar(2 * s, s), lines(body, true)])], rect(4 * s, y - half, Math.max(0, w - l - 4 * s), 2 * half));
  },
};

/** The tail's tip as fractions of the box from its top left: below the left quarter by default. */
const TAIL_ADJ = [0.25, 1.35];

/** A rectangle (rounded or not) with a wedge out of the side that faces its tip. */
const boxCallout = (rounded: boolean): Canonical => ({
  defaultAdj: TAIL_ADJ,
  build(w, h, adj) {
    const tip = pt(w * adj(0), h * adj(1));
    const r = rounded ? Math.min(w, h) / 6 : 0;
    // Walk round the box clockwise; the side facing the tip gets the wedge.
    const d = pt((tip.x - w / 2) / Math.max(w / 2, 1e-9), (tip.y - h / 2) / Math.max(h / 2, 1e-9));
    const wedge = Math.abs(d.x) > Math.abs(d.y) ? (d.x > 0 ? 1 : 3) : d.y > 0 ? 2 : 0;
    const corners = [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)];
    const segs: Seg[] = [];
    const k = r * KAPPA;
    let start: Pt | null = null;
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const bp = corners[(i + 1) % 4];
      const dir = vnorm(vsub(bp, a));
      const from = vadd(a, vscale(dir, r));
      const to = vsub(bp, vscale(dir, r));
      if (start === null) start = from;
      if (i === wedge) {
        const len = vdist(from, to);
        const base = len * 0.18;
        const rel = vsub(tip, from);
        const along = clamp(rel.x * dir.x + rel.y * dir.y, base, len - base);
        segs.push(L(vadd(from, vscale(dir, along - base / 2))), L(tip), L(vadd(from, vscale(dir, along + base / 2))));
      }
      segs.push(L(to));
      if (r > 0) {
        const ndir = vnorm(vsub(corners[(i + 2) % 4], bp));
        segs.push(C(vadd(to, vscale(dir, k)), vadd(bp, vscale(ndir, r - k)), vadd(bp, vscale(ndir, r))));
      }
    }
    return geom([sp([contour(start ?? pt(0, 0), segs, true)])], inset(rect(0, 0, w, h)));
  },
});

/** An ellipse with a wedge out toward its tip. */
const ovalCallout: Canonical = {
  defaultAdj: TAIL_ADJ,
  build(w, h, adj) {
    const tip = pt(w * adj(0), h * adj(1));
    const c = pt(w / 2, h / 2);
    const toward = Math.atan2((tip.y - c.y) / Math.max(h / 2, 1e-9), (tip.x - c.x) / Math.max(w / 2, 1e-9));
    const spread = 0.25;
    const rim = (a: number): Pt => pt(c.x + (w / 2) * Math.cos(a), c.y + (h / 2) * Math.sin(a));
    const segs = [...arcSegments(c, w / 2, h / 2, toward + spread, 2 * Math.PI - 2 * spread), L(tip)];
    const k = 1 / Math.sqrt(2);
    return geom([sp([contour(rim(toward + spread), segs, true)])], rect(c.x - (w / 2) * k, c.y - (h / 2) * k, w * k, h * k));
  },
};

/** A cloud with three bubbles shrinking away toward its tip. */
const thoughtCallout: Canonical = {
  defaultAdj: TAIL_ADJ,
  build(w, h, adj) {
    const body = rect(0, 0, w, h);
    const cloud = CLOUD.build(body, { adj: [], n: 0, path: null, width: 2 }).paths[0].contours[0];
    const tip = pt(w * adj(0), h * adj(1));
    const c = center(body);
    // The bubbles start just past the cloud's rim on the way to the tip and shrink as they go.
    const a = Math.atan2((tip.y - c.y) / Math.max(h / 2, 1e-9), (tip.x - c.x) / Math.max(w / 2, 1e-9));
    const edge = pt(c.x + (w / 2) * 1.08 * Math.cos(a), c.y + (h / 2) * 1.08 * Math.sin(a));
    const r0 = Math.min(w, h) * 0.09;
    const bubbles = ([[0.15, 1.0], [0.55, 0.66], [0.92, 0.4]] as const).map(([f, s]) => {
      const at = vadd(edge, vscale(vsub(tip, edge), f));
      return ellipseContour(at.x, at.y, r0 * s, r0 * s);
    });
    return geom([sp([cloud, ...bubbles])], inset(body, 0.2));
  },
};

/** A plain box with a leader line from its nearest side out to the tip. */
const lineCallout: Canonical = {
  defaultAdj: TAIL_ADJ,
  build(w, h, adj) {
    const body = rect(0, 0, w, h);
    const tip = pt(w * adj(0), h * adj(1));
    const anchor = [pt(w / 2, 0), pt(w, h / 2), pt(w / 2, h), pt(0, h / 2)].reduce((best, q) => (vdist(q, tip) < vdist(best, tip) ? q : best));
    return geom([sp([lines(rectCorners(body), true)]), sp([lines([anchor, tip], false)], "STROKE_ONLY")], inset(body));
  },
};

/** An explosion: a jagged star of uneven spikes. */
const burst: Canonical = {
  defaultAdj: [],
  build(w, h) {
    const radii = [1.0, 0.55, 0.9, 0.5, 0.97, 0.58, 0.82, 0.5, 1.0, 0.6, 0.86, 0.48, 0.95, 0.56, 0.88, 0.52];
    const unit = radii.map((r, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / radii.length + (i % 2 === 0 ? 0.05 : -0.04);
      return pt(r * Math.cos(a), r * Math.sin(a));
    });
    const bb = bounding(unit);
    const pts = unit.map((u) => pt(((u.x - bb.x) / bb.w) * w, ((u.y - bb.y) / bb.h) * h));
    return geom([polygonPath(pts)], inset(rect(0, 0, w, h), 0.28));
  },
};

// --- SolidMathKinds.kt ---

const poly = (points: Pt[], role: PathRole): ShapePath => polygonPath(points, role);
const line = (role: PathRole, ...points: Pt[]): ShapePath => polylinePath(points, role);
const onEllipse = (c: Pt, rx: number, ry: number, d: number): Pt => pt(c.x + rx * Math.cos(rad(d)), c.y + ry * Math.sin(rad(d)));
const arc = (c: Pt, rx: number, ry: number, startDeg: number, sweepDeg: number, role: PathRole): ShapePath =>
  sp([contour(onEllipse(c, rx, ry, startDeg), arcSegments(c, rx, ry, rad(startDeg), rad(sweepDeg)), false)], role);

/** A solid: its paths for a depth (the knob's share of the shorter side, 0.05..0.6). */
const solidKind = (id: string, draw: (b: Rect, d: number) => ShapePath[], text: (b: Rect, d: number) => Rect = (b) => inset(b, 0.2)): ShapeKind =>
  makeKind(id, { closed: true, adj: [0.25] }, (box, _p, adj) => {
    const d = clamp(adj(0), 0.05, 0.6) * Math.min(box.w, box.h);
    return geom(draw(box, d), text(box, d));
  });

/** A notation drawing: lines, ticks and its own arrowheads, never filled unless it is a grid. */
const notationKind = (id: string, o: { closed?: boolean; n?: number; adj?: number[] }, draw: (b: Rect, p: ShapeParams) => ShapePath[]): ShapeKind =>
  makeKind(id, { closed: o.closed ?? false, n: o.n, adj: o.adj }, (box, p) => geom(draw(box, p), inset(box, 0.1)));

/** [count] ticks across the line [from]-[to], the first on [from] and the last on [to]. */
function ticksEndToEnd(from: Pt, to: Pt, count: number, half: number): Contour[] {
  if (count <= 0) return [];
  const d = vsub(to, from);
  const len = vlen(d);
  if (len < 1e-9) return [];
  const n = vscale(vperp(d), half / len);
  return Array.from({ length: count }, (_, i) => {
    const at = count === 1 ? vadd(from, vscale(d, 0.5)) : vadd(from, vscale(d, i / (count - 1)));
    return lines([vsub(at, n), vadd(at, n)], false);
  });
}

/** [count] ticks spread evenly between [from] and [to], neither end ticked. */
function ticks(from: Pt, to: Pt, count: number, half: number): Contour[] {
  if (count <= 0) return [];
  const d = vsub(to, from);
  const len = vlen(d);
  if (len < 1e-9) return [];
  const n = vscale(vperp(d), half / len);
  return Array.from({ length: count }, (_, k) => {
    const at = vadd(from, vscale(d, (k + 1) / (count + 1)));
    return lines([vsub(at, n), vadd(at, n)], false);
  });
}

/** The unit direction of a ray [d] degrees anticlockwise from the right, on screen. */
const ray = (d: number): Pt => pt(Math.cos(rad(d)), -Math.sin(rad(d)));

/** Where an angle of [d] puts its vertex: the bottom left, slid right just enough for an obtuse ray to fit. */
function vertex(b: Rect, d: number): Pt {
  const r = ray(d);
  const slide = r.x < 0 ? Math.min((b.h * -r.x) / -r.y, b.w * 0.8) : 0;
  return pt(b.x + slide, bottom(b));
}

const SOLID_MATH_KINDS: ShapeKind[] = [
  solidKind(
    "solid_cube",
    (b, d) => {
      const l = b.x;
      const t = b.y;
      const r = right(b);
      const bt = bottom(b);
      return [
        poly([pt(l, t + d), pt(l + d, t), pt(r, t), pt(r - d, t + d)], "SHADE_LIGHT"),
        poly([pt(r - d, t + d), pt(r, t), pt(r, bt - d), pt(r - d, bt)], "SHADE_DARK"),
        poly([pt(l, t + d), pt(r - d, t + d), pt(r - d, bt), pt(l, bt)], "OUTLINE"),
        sp([lines([pt(l, t + d), pt(l + d, t), pt(r, t), pt(r - d, t + d)], false), lines([pt(r, t), pt(r, bt - d), pt(r - d, bt)], false)], "STROKE_ONLY"),
        sp([lines([pt(l + d, t), pt(l + d, bt - d), pt(r, bt - d)], false), lines([pt(l + d, bt - d), pt(l, bt)], false)], "HIDDEN"),
      ];
    },
    (b, d) => inset(rect(b.x, b.y + d, b.w - d, b.h - d)),
  ),
  solidKind(
    "solid_cylinder",
    (b, d) => {
      const ry = d / 2;
      const rx = b.w / 2;
      const top = pt(cx(b), b.y + ry);
      const bot = pt(cx(b), bottom(b) - ry);
      const body = contour(
        pt(b.x, top.y),
        [L(pt(b.x, bot.y)), ...arcSegments(bot, rx, ry, Math.PI, -Math.PI), L(pt(right(b), top.y)), ...arcSegments(top, rx, ry, 0, -Math.PI)],
        true,
      );
      return [sp([body]), sp([ellipseContour(top.x, top.y, rx, ry)], "SHADE_LIGHT"), arc(top, rx, ry, 180, -180, "STROKE_ONLY"), arc(bot, rx, ry, 180, 180, "HIDDEN")];
    },
    (b, d) => inset(rect(b.x, b.y + d, b.w, b.h - 1.5 * d)),
  ),
  solidKind(
    "solid_cone",
    (b, d) => {
      const ry = d / 2;
      const base = pt(cx(b), bottom(b) - ry);
      const body = contour(pt(cx(b), b.y), [L(pt(b.x, base.y)), ...arcSegments(base, b.w / 2, ry, Math.PI, -Math.PI)], true);
      return [sp([body]), arc(base, b.w / 2, ry, 180, 180, "HIDDEN")];
    },
    (b, d) => inset(rect(b.x + b.w / 4, b.y + b.h / 2, b.w / 2, b.h / 2 - d)),
  ),
  solidKind(
    "solid_sphere",
    (b, d) => {
      const ry = d / 2;
      return [
        sp([ellipseContour(cx(b), cy(b), b.w / 2, b.h / 2)]),
        arc(center(b), b.w / 2, ry, 180, -180, "STROKE_ONLY"),
        arc(center(b), b.w / 2, ry, 180, 180, "HIDDEN"),
      ];
    },
    (b) => inset(b, 0.25),
  ),
  solidKind(
    "solid_pyramid",
    (b, d) => {
      const apex = pt(cx(b), b.y);
      const fl = pt(b.x, bottom(b));
      const fr = pt(right(b) - d, bottom(b));
      const br = pt(right(b), bottom(b) - d);
      const bl = pt(b.x + d, bottom(b) - d);
      return [
        poly([apex, fl, fr, br], "OUTLINE"),
        poly([apex, fr, br], "SHADE_DARK"),
        line("STROKE_ONLY", apex, fr),
        sp([lines([br, bl, fl], false), lines([apex, bl], false)], "HIDDEN"),
      ];
    },
    (b, d) => inset(rect(b.x + b.w / 4, b.y + b.h / 2, b.w / 2 - d / 2, b.h / 2)),
  ),
  solidKind(
    "solid_tetrahedron",
    (b, d) => {
      const apex = pt(b.x + 0.45 * b.w, b.y);
      const fl = pt(b.x, bottom(b));
      const fr = pt(b.x + 0.68 * b.w, bottom(b));
      const back = pt(right(b), bottom(b) - d);
      return [poly([apex, fl, fr, back], "OUTLINE"), poly([apex, fr, back], "SHADE_DARK"), line("STROKE_ONLY", apex, fr), line("HIDDEN", fl, back)];
    },
    (b) => inset(rect(b.x + 0.2 * b.w, b.y + 0.5 * b.h, 0.4 * b.w, 0.45 * b.h)),
  ),
  solidKind(
    "solid_tri_prism",
    (b, d) => {
      const f0 = pt(b.x, bottom(b));
      const f1 = pt(right(b) - d, bottom(b));
      const f2 = pt((b.x + right(b) - d) / 2, b.y + d);
      const shift = pt(d, -d);
      const b0 = vadd(f0, shift);
      const b1 = vadd(f1, shift);
      const b2 = vadd(f2, shift);
      return [
        poly([f0, f1, b1, b2, f2], "OUTLINE"),
        poly([f1, b1, b2, f2], "SHADE_DARK"),
        line("STROKE_ONLY", f1, f2),
        sp([lines([b1, b0, b2], false), lines([b0, f0], false)], "HIDDEN"),
      ];
    },
    (b, d) => inset(rect(b.x + (b.w - d) / 4, b.y + b.h / 2, (b.w - d) / 2, b.h / 2)),
  ),
  solidKind(
    "solid_hex_prism",
    (b, d) => {
      const ry = d / 2;
      const rx = b.w / 2;
      const top = pt(cx(b), b.y + ry);
      const bot = pt(cx(b), bottom(b) - ry);
      const t = Array.from({ length: 6 }, (_, i) => onEllipse(top, rx, ry, 60 * i));
      const u = Array.from({ length: 6 }, (_, i) => onEllipse(bot, rx, ry, 60 * i));
      // Corners 0 to 3 run round the front (sines at or below zero in screen space are the back).
      return [
        poly([t[3], t[4], t[5], t[0], u[0], u[1], u[2], u[3]], "OUTLINE"),
        poly(t, "SHADE_LIGHT"),
        sp([lines([t[0], t[1], t[2], t[3]], false), lines([t[1], u[1]], false), lines([t[2], u[2]], false)], "STROKE_ONLY"),
        sp([lines([u[3], u[4], u[5], u[0]], false), lines([t[4], u[4]], false), lines([t[5], u[5]], false)], "HIDDEN"),
      ];
    },
    (b, d) => inset(rect(b.x, b.y + d, b.w, b.h - 1.5 * d)),
  ),
  solidKind(
    "solid_frustum",
    (b, d) => {
      const ry = d / 2;
      const rx = b.w / 2;
      const tx = rx * 0.6;
      const ty = ry * 0.6;
      const top = pt(cx(b), b.y + ty);
      const bot = pt(cx(b), bottom(b) - ry);
      const body = contour(
        pt(top.x - tx, top.y),
        [L(pt(b.x, bot.y)), ...arcSegments(bot, rx, ry, Math.PI, -Math.PI), L(pt(top.x + tx, top.y)), ...arcSegments(top, tx, ty, 0, -Math.PI)],
        true,
      );
      return [sp([body]), sp([ellipseContour(top.x, top.y, tx, ty)], "SHADE_LIGHT"), arc(top, tx, ty, 180, -180, "STROKE_ONLY"), arc(bot, rx, ry, 180, 180, "HIDDEN")];
    },
    (b, d) => inset(rect(b.x + b.w * 0.2, b.y + d, b.w * 0.6, b.h - 1.5 * d)),
  ),
  solidKind(
    "solid_hemisphere",
    (b, d) => {
      const ry = d / 2;
      const base = pt(cx(b), bottom(b) - ry);
      const dome = contour(pt(b.x, base.y), [...arcSegments(base, b.w / 2, base.y - b.y, Math.PI, Math.PI), ...arcSegments(base, b.w / 2, ry, 0, Math.PI)], true);
      return [sp([dome]), arc(base, b.w / 2, ry, 180, 180, "HIDDEN")];
    },
    (b, d) => inset(rect(b.x + b.w * 0.2, b.y + b.h * 0.3, b.w * 0.6, b.h * 0.7 - d)),
  ),
  notationKind("math_axes_2d", { n: 5 }, (b, p) => {
    const o = pt(b.x + 0.12 * b.w, bottom(b) - 0.12 * b.h);
    const tick = 0.025 * Math.min(b.w, b.h);
    const head = headLength(p.width);
    const yTip = pt(o.x, b.y);
    const xTip = pt(right(b), o.y);
    return [
      sp(
        [
          lines([pt(o.x, bottom(b)), yTip], false),
          lines([pt(b.x, o.y), xTip], false),
          ...ticks(o, pt(o.x, b.y + head), p.n, tick),
          ...ticks(o, pt(right(b) - head, o.y), p.n, tick),
        ],
        "STROKE_ONLY",
      ),
      ...headPaths("open", yTip, pt(0, -1), p.width),
      ...headPaths("open", xTip, pt(1, 0), p.width),
    ];
  }),
  notationKind("math_axes_3d", {}, (b, p) => {
    const o = pt(b.x + 0.35 * b.w, bottom(b) - 0.35 * b.h);
    const tips = [pt(o.x, b.y), pt(right(b), o.y), pt(b.x, bottom(b))];
    return [sp(tips.map((tip) => lines([o, tip], false)), "STROKE_ONLY"), ...tips.flatMap((tip) => headPaths("open", tip, vnorm(vsub(tip, o)), p.width))];
  }),
  notationKind("math_number_line", { n: 9 }, (b, p) => {
    const y = cy(b);
    const ins = headLength(p.width) * 1.5;
    return [
      sp([lines([pt(b.x, y), pt(right(b), y)], false), ...ticksEndToEnd(pt(b.x + ins, y), pt(right(b) - ins, y), p.n, 0.3 * b.h)], "STROKE_ONLY"),
      ...headPaths("open", pt(right(b), y), pt(1, 0), p.width),
      ...headPaths("open", pt(b.x, y), pt(-1, 0), p.width),
    ];
  }),
  notationKind("math_grid", { closed: true, n: 4 }, (b, p) => {
    const n = clamp(p.n, 1, 24);
    const inner: Contour[] = [];
    for (let i = 1; i < n; i++) {
      const x = b.x + (b.w * i) / n;
      const y = b.y + (b.h * i) / n;
      inner.push(lines([pt(x, b.y), pt(x, bottom(b))], false), lines([pt(b.x, y), pt(right(b), y)], false));
    }
    return [rectPath(b), sp(inner, "STROKE_ONLY")];
  }),
  notationKind("math_angle", { adj: [50] }, (b, p) => {
    // Kotlin reads adj.getOrNull(0) ?: 50 here, not adjOf.
    const d = clamp(p.adj[0] ?? 50, 5, 175);
    const v = vertex(b, d);
    const dir = ray(d);
    // The second ray runs out to wherever it meets the box: its top, or a side.
    const reaches = [
      dir.y < -1e-9 ? b.h / -dir.y : null,
      dir.x > 1e-9 ? (right(b) - v.x) / dir.x : null,
      dir.x < -1e-9 ? (v.x - b.x) / -dir.x : null,
    ].filter((r): r is number => r !== null && r > 1e-9);
    const reach = reaches.length ? Math.min(...reaches) : b.h;
    // The arc fits inside both rays, however short a slid vertex leaves the first.
    const r = Math.min(0.3 * Math.min(b.w, b.h), 0.6 * (right(b) - v.x), 0.6 * reach);
    return [
      sp([lines([pt(right(b), bottom(b)), v, vadd(v, vscale(dir, reach))], false)], "STROKE_ONLY"),
      sp([contour(pt(v.x + r, v.y), arcSegments(v, r, r, 0, -rad(d)), false)], "STROKE_ONLY"),
    ];
  }),
  notationKind("math_right_angle", {}, (b) => {
    const s = 0.22 * Math.min(b.w, b.h);
    return [
      sp(
        [lines([pt(right(b), bottom(b)), pt(b.x, bottom(b)), topLeft(b)], false), lines([pt(b.x + s, bottom(b)), pt(b.x + s, bottom(b) - s), pt(b.x, bottom(b) - s)], false)],
        "STROKE_ONLY",
      ),
    ];
  }),
  notationKind("math_curly_brace", {}, (b) => {
    const at = (x: number, y: number): Pt => pt(b.x + x * b.w, b.y + y * b.h);
    const c = contour(
      at(1, 0),
      [
        C(at(0.5, 0), at(0.5, 0.06), at(0.5, 0.12)),
        L(at(0.5, 0.38)),
        C(at(0.5, 0.45), at(0.25, 0.5), at(0, 0.5)),
        C(at(0.25, 0.5), at(0.5, 0.55), at(0.5, 0.62)),
        L(at(0.5, 0.88)),
        C(at(0.5, 0.94), at(0.5, 1), at(1, 1)),
      ],
      false,
    );
    return [sp([c], "STROKE_ONLY")];
  }),
  notationKind("math_square_bracket", {}, (b) => [polylinePath([pt(right(b), b.y), topLeft(b), pt(b.x, bottom(b)), pt(right(b), bottom(b))])]),
  notationKind("math_round_bracket", {}, (b) => [
    sp([contour(pt(right(b), b.y), arcSegments(pt(right(b), cy(b)), b.w, b.h / 2, -Math.PI / 2, -Math.PI), false)], "STROKE_ONLY"),
  ]),
];

// --- the registry (ShapeKind.all order) ---

const CLOUD = cloudKind("cloud");

const single = singleArrow(false);

const ARROW_KINDS: ShapeKind[] = [
  orientedKind("arrow_right", "RIGHT", single),
  orientedKind("arrow_left", "LEFT", single),
  orientedKind("arrow_up", "UP", single),
  orientedKind("arrow_down", "DOWN", single),
  orientedKind("arrow_left_right", "RIGHT", doubleArrow),
  orientedKind("arrow_up_down", "UP", doubleArrow),
  boxedKind("arrow_quad", quadArrow),
  boxedKind("arrow_bent", bentArrow(false)),
  boxedKind("arrow_u_turn", uTurnArrow),
  orientedKind("arrow_chevron", "RIGHT", pointedBand(true)),
  orientedKind("arrow_pentagon", "RIGHT", pointedBand(false)),
  orientedKind("arrow_notched", "RIGHT", singleArrow(true)),
  orientedKind("arrow_curved_right", "RIGHT", curvedArrow),
  orientedKind("arrow_curved_left", "LEFT", curvedArrow),
  boxedKind("arrow_circular", circularArrow),
  orientedKind("arrow_striped", "RIGHT", stripedArrow),
  boxedKind("arrow_bent_up", bentArrow(true)),
  boxedKind("arrow_left_up", leftUpArrow),
  boxedKind("callout_rect", boxCallout(false)),
  boxedKind("callout_round", boxCallout(true)),
  boxedKind("callout_oval", ovalCallout),
  boxedKind("callout_thought", thoughtCallout),
  boxedKind("callout_line", lineCallout),
  boxedKind("burst", burst),
];

export const ALL_KINDS: ShapeKind[] = [
  endpointKind("line", "none"),
  endpointKind("arrow", "open"),
  rectangleKind("rectangle"),
  ellipseKind("ellipse"),
  ellipseKind("circle"),
  triangleKind("triangle"),
  freeKind("polygon", true),
  freeKind("polyline", false),
  freeKind("curve", false),
  roundedRectKind("rounded_rect", false),
  rectangleKind("square"),
  roundedRectKind("capsule", true),
  rightTriangleKind("right_triangle"),
  diamondKind("diamond"),
  parallelogramKind("parallelogram"),
  trapezoidKind("trapezoid"),
  regularPolygonKind("regular_polygon"),
  starKind("star"),
  crossKind("cross"),
  heartKind("heart"),
  CLOUD,
  ringKind("ring"),
  sliceKind("pie", true),
  sliceKind("arc", false),
  glyphsKind("glyphs"),
  fillKind("fill"),
  ...FLOWCHART_KINDS,
  ...ARROW_KINDS,
  ...SOLID_MATH_KINDS,
];

const BY_ID = new Map(ALL_KINDS.map((k) => [k.id, k]));

/** The kind [id] names, or undefined for one this version does not know. */
export const kindById = (id: string | undefined | null): ShapeKind | undefined => (id == null ? undefined : BY_ID.get(id));
