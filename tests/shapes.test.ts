// Tests for the shape geometry port; numeric assertions copied from XNotes app/src/test/.../core/shapes/*Test.kt.
import { describe, expect, test } from "bun:test";
import * as FreePath from "../src/shapes/freePath";
import { attachHeads, headPaths } from "../src/shapes/head";
import { ALL_KINDS, adjOf, kindById } from "../src/shapes/kinds";
import { bounding, lines, polylinePath, pt, rect, vdist, vnorm, vsub, type Contour, type Pt, type Rect, type ShapeKind, type ShapeParams } from "../src/shapes/types";

const unitSquare: Contour[] = [lines([pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)], true)];
const params = (k: ShapeKind, o: Partial<ShapeParams> = {}): ShapeParams => ({
  adj: k.defaultAdj,
  n: k.defaultN,
  path: k.isFree ? unitSquare : null,
  width: 2,
  ...o,
});
const kind = (id: string): ShapeKind => {
  const k = kindById(id);
  if (!k) throw new Error(`no kind ${id}`);
  return k;
};
const build = (id: string, box: Rect, o: Partial<ShapeParams> = {}) => kind(id).build(box, params(kind(id), o));
const pts = (c: Contour): Pt[] => [c.start, ...c.segs.map((s) => s.end)];
const allPoints = (c: Contour): Pt[] => [c.start, ...c.segs.flatMap((s) => (s.t === "L" ? [s.end] : [s.c1, s.c2, s.end]))];
const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return pt(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y);
}

function flatten(c: Contour, steps = 64): Pt[] {
  const out = [c.start];
  let from = c.start;
  for (const s of c.segs) {
    if (s.t === "L") out.push(s.end);
    else for (let i = 1; i <= steps; i++) out.push(cubicAt(from, s.c1, s.c2, s.end, i / steps));
    from = s.end;
  }
  return out;
}

function area(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

describe("every kind", () => {
  const box = rect(10, 20, 200, 120);

  test("ids are unique and read back", () => {
    expect(new Set(ALL_KINDS.map((k) => k.id)).size).toBe(ALL_KINDS.length);
    for (const k of ALL_KINDS) expect(kindById(k.id)).toBe(k);
    expect(kindById("hexagram")).toBeUndefined();
    expect(kindById(null)).toBeUndefined();
    expect(kindById(undefined)).toBeUndefined();
  });

  test("builds with default params", () => {
    for (const k of ALL_KINDS) {
      const g = k.build(box, params(k));
      expect(g.paths.length).toBeGreaterThan(0);
      expect(g.paths.some((p) => p.contours.length > 0)).toBe(true);
      for (const p of g.paths) for (const c of p.contours) for (const q of allPoints(c)) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
      expect(Number.isFinite(g.textRect.w) && Number.isFinite(g.textRect.h)).toBe(true);
    }
  });

  test("counts match the Kotlin families", () => {
    expect(ALL_KINDS.length).toBe(26 + 17 + 24 + 19);
    expect(ALL_KINDS.filter((k) => k.id.startsWith("solid_")).length).toBe(10);
  });

  // BasicKindsTest.everyKindDrawsInsideItsBox, using exact bounds instead of a flattener.
  test("every non-legacy kind that stays in its box draws inside it", () => {
    const b0 = rect(10, 20, 120, 80);
    const legacy = new Set(["line", "arrow", "rectangle", "ellipse", "circle", "triangle", "polygon", "polyline", "curve"]);
    const leaves = new Set(["callout_rect", "callout_round", "callout_oval", "callout_thought", "callout_line", "math_axes_2d", "math_axes_3d", "math_number_line"]);
    for (const k of ALL_KINDS.filter((k) => !legacy.has(k.id) && !k.isFree && !leaves.has(k.id))) {
      const g = k.build(b0, params(k));
      const b = FreePath.bounds(g.paths.flatMap((p) => p.contours));
      if (!b) throw new Error(k.id);
      const inside = b.x >= b0.x - 1e-6 && b.y >= b0.y - 1e-6 && right(b) <= right(b0) + 1e-6 && bottom(b) <= bottom(b0) + 1e-6;
      expect(`${k.id} ${inside}`).toBe(`${k.id} true`);
      expect(b.w > b0.w * 0.3 && b.h > b0.h * 0.3).toBe(true);
      const t = g.textRect;
      expect(t.x >= b0.x - 1e-6 && right(t) <= right(b0) + 1e-6).toBe(true);
    }
  });
});

describe("ShapeKind.kt", () => {
  const box = rect(10, 20, 100, 60);

  test("rectangle is 4 corners in a closed contour", () => {
    const c = build("rectangle", box).paths[0].contours;
    expect(c.length).toBe(1);
    expect(c[0].closed).toBe(true);
    expect(pts(c[0])).toEqual([pt(10, 20), pt(110, 20), pt(110, 80), pt(10, 80)]);
  });

  test("ellipse is 4 cubics and its label box touches it at its corners", () => {
    const g = build("ellipse", box);
    const c = g.paths[0].contours[0];
    expect(c.segs.length).toBe(4);
    expect(c.segs.every((s) => s.t === "C")).toBe(true);
    const t = g.textRect;
    expect(((right(t) - 60) / 50) ** 2 + ((bottom(t) - 50) / 30) ** 2).toBeCloseTo(1, 9);
  });

  test("triangle apex in the middle; missing knob reads as default", () => {
    expect(pts(build("triangle", box).paths[0].contours[0])[0]).toEqual(pt(60, 20));
    expect(adjOf(kind("triangle"), [], 0)).toBe(0.5);
    expect(adjOf(kind("triangle"), [Number.NaN], 0)).toBe(0.5);
    expect(pts(build("triangle", box, { adj: [0.25] }).paths[0].contours[0])[0]).toEqual(pt(35, 20));
  });

  test("a free outline is placed in its box", () => {
    const unit = [lines([pt(0, 0), pt(1, 0), pt(0.5, 1)], true)];
    const g = build("polygon", box, { path: unit });
    expect(FreePath.vertices(g.paths[0].contours[0])).toEqual([pt(10, 20), pt(110, 20), pt(60, 80)]);
    expect(g.paths[0].role).toBe("OUTLINE");
    expect(build("polyline", box, { path: unit }).paths[0].role).toBe("STROKE_ONLY");
    expect(build("fill", box, { path: unit }).paths[0].fillRule).toBe("evenodd");
    expect(build("glyphs", box, { path: unit }).paths[0].role).toBe("FILL_ONLY");
  });

  test("endpoint kinds and their default heads", () => {
    expect(kind("line").isEndpointShape && kind("arrow").isEndpointShape).toBe(true);
    expect(kind("arrow").defaultHeadEnd).toBe("open");
    expect(kind("arrow").defaultHeadStart).toBe("none");
    expect(kind("line").defaultHeadEnd).toBe("none");
    expect(kind("polygon").isFree && kind("polyline").isFree && kind("curve").isFree).toBe(true);
    expect(kind("polygon").isClosed && !kind("curve").isClosed).toBe(true);
  });
});

describe("BasicKinds.kt", () => {
  const box = rect(10, 20, 120, 80);

  test("star with default n has 2n vertices; cross 12; regular polygon n", () => {
    const star = kind("star");
    expect(FreePath.vertices(build("star", box).paths[0].contours[0]).length).toBe(2 * star.defaultN);
    expect(FreePath.vertices(build("cross", box).paths[0].contours[0]).length).toBe(12);
    for (const n of [5, 6, 8]) expect(FreePath.vertices(build("regular_polygon", box, { n }).paths[0].contours[0]).length).toBe(n);
  });

  test("a regular polygon fills its box", () => {
    const b = bounding(FreePath.vertices(build("regular_polygon", box, { n: 5 }).paths[0].contours[0]));
    expect(b.x).toBeCloseTo(box.x, 9);
    expect(bottom(b)).toBeCloseTo(bottom(box), 9);
    expect(b.w).toBeCloseTo(box.w, 9);
  });

  test("a five-point star is the classic one", () => {
    const square = rect(0, 0, 100, 100);
    const corners = FreePath.vertices(build("star", square, { n: 5 }).paths[0].contours[0]);
    const c = pt(50, 50 + (50 * (1 - Math.cos(Math.PI / 5))) / (1 + Math.cos(Math.PI / 5)));
    const ratio = vdist(corners[1], c) / vdist(corners[0], c);
    expect(Math.abs(ratio - 0.382)).toBeLessThan(0.06);
  });

  test("a pie is three quarters; an arc is open", () => {
    const g = build("pie", box);
    const full = Math.PI * 60 * 40;
    expect(Math.abs(area(flatten(g.paths[0].contours[0])) - 0.75 * full)).toBeLessThan(full * 0.01);
    const arc = build("arc", box).paths[0];
    expect(arc.role).toBe("STROKE_ONLY");
    expect(arc.contours[0].closed).toBe(false);
    expect(kind("arc").isClosed).toBe(false);
  });

  test("a ring fills by parity", () => {
    const p = build("ring", box).paths[0];
    expect(p.fillRule).toBe("evenodd");
    expect(p.contours.length).toBe(2);
  });
});

describe("FlowchartKinds.kt", () => {
  const box = rect(0, 0, 150, 90);
  const roles = (id: string) => build(id, box).paths.map((p) => p.role);

  test("detail lines are stroked over the outline", () => {
    expect(roles("flow_predefined")).toEqual(["OUTLINE", "STROKE_ONLY"]);
    expect(build("flow_predefined", box).paths[1].contours.length).toBe(2);
    expect(roles("flow_database")).toEqual(["OUTLINE", "STROKE_ONLY"]);
    expect(roles("flow_summing")).toEqual(["OUTLINE", "STROKE_ONLY"]);
  });

  test("a stack shows its back pages as edges behind the front one", () => {
    const paths = build("flow_multidocument", box).paths;
    expect(paths.map((p) => p.role)).toEqual(["STROKE_ONLY", "OUTLINE"]);
    expect(paths[0].contours.length).toBe(2);
    expect(paths[0].contours.every((c) => !c.closed)).toBe(true);
  });

  test("a document's wave touches the bottom edge", () => {
    const b = FreePath.bounds(build("flow_document", box).paths[0].contours);
    expect(b && bottom(b)).toBeCloseTo(bottom(box), 9);
  });

  test("straight symbols have their corners", () => {
    expect(FreePath.vertices(build("flow_preparation", box).paths[0].contours[0]).length).toBe(6);
    expect(FreePath.vertices(build("flow_off_page", box).paths[0].contours[0]).length).toBe(5);
    expect(FreePath.vertices(build("flow_merge", box).paths[0].contours[0]).length).toBe(3);
  });
});

describe("ArrowKinds.kt", () => {
  const box = rect(10, 20, 160, 80);
  const corners = (id: string) => FreePath.vertices(build(id, box).paths[0].contours[0]);
  const near = (ps: Pt[], q: Pt) => ps.some((p) => vdist(p, q) < 1e-9);

  test("each direction points its own way", () => {
    expect(near(corners("arrow_right"), pt(right(box), box.y + box.h / 2))).toBe(true);
    expect(near(corners("arrow_left"), pt(box.x, box.y + box.h / 2))).toBe(true);
    expect(near(corners("arrow_up"), pt(box.x + box.w / 2, box.y))).toBe(true);
    expect(near(corners("arrow_down"), pt(box.x + box.w / 2, bottom(box)))).toBe(true);
    const both = corners("arrow_left_right");
    expect(near(both, pt(box.x, box.y + box.h / 2)) && near(both, pt(right(box), box.y + box.h / 2))).toBe(true);
  });

  test("a circular arrow's head is twice its ring", () => {
    const segs = build("arrow_circular", rect(0, 0, 200, 200)).paths[0].contours[0].segs.filter((s) => s.t === "L");
    expect(vdist(segs[0].end, segs[2].end)).toBeCloseTo(50, 9);
  });

  test("a thought bubble trails three bubbles; a line callout's leader is a stroke", () => {
    expect(build("callout_thought", box).paths[0].contours.length).toBe(4);
    expect(build("callout_line", box).paths.map((p) => p.role)).toEqual(["OUTLINE", "STROKE_ONLY"]);
  });

  test("a callout's tail reaches its tip below the box", () => {
    const b = FreePath.bounds(build("callout_rect", box).paths[0].contours);
    expect(b && bottom(b)).toBeCloseTo(box.y + box.h * 1.35, 9);
  });
});

describe("SolidMathKinds.kt", () => {
  const box = rect(10, 20, 120, 100);

  test("every solid dashes its hidden edges; a cube shades top and side", () => {
    const solids = ALL_KINDS.filter((k) => k.id.startsWith("solid_"));
    for (const k of solids) expect(k.build(box, params(k)).paths.some((p) => p.role === "HIDDEN")).toBe(true);
    const roles = build("solid_cube", box).paths.map((p) => p.role);
    expect(roles.includes("SHADE_LIGHT") && roles.includes("SHADE_DARK")).toBe(true);
  });

  test("axes count their ticks and carry heads as wide as the line", () => {
    const g = build("math_axes_2d", box, { n: 4 });
    expect(g.paths.find((p) => p.role === "STROKE_ONLY")?.contours.length).toBe(2 + 8);
    expect(g.paths.filter((p) => p.role === "HEAD").length).toBe(2);
    const headSpan = (width: number) => {
      const head = build("math_axes_2d", box, { width }).paths.find((p) => p.role === "HEAD");
      if (!head) throw new Error("no head");
      const ps = pts(head.contours[0]);
      return vdist(ps[0], ps[ps.length - 1]);
    };
    expect(headSpan(2)).toBeCloseTo(12, 9);
    expect(headSpan(8)).toBeCloseTo(28, 9);
  });

  test("a number line ticks end to end; a grid draws its cells", () => {
    const g = build("math_number_line", box, { n: 5 });
    expect(g.paths.find((p) => p.role === "STROKE_ONLY")?.contours.length).toBe(6);
    expect(g.paths.filter((p) => p.role === "HEAD").length).toBe(2);
    const grid = build("math_grid", box, { n: 3 });
    expect(grid.paths[0].role).toBe("OUTLINE");
    expect(grid.paths[1].contours.length).toBe(4);
    expect(kind("math_grid").isClosed).toBe(true);
  });

  test("an obtuse angle stays in its box", () => {
    for (const d of [20, 90, 120, 170]) {
      const b = FreePath.bounds(build("math_angle", box, { adj: [d] }).paths.flatMap((p) => p.contours));
      if (!b) throw new Error("empty");
      expect(b.x >= box.x - 1e-6 && right(b) <= right(box) + 1e-6 && b.y >= box.y - 1e-6).toBe(true);
    }
  });

  test("notation lines are open", () => {
    for (const id of ["math_axes_2d", "math_axes_3d", "math_number_line", "math_angle", "math_right_angle", "math_curly_brace", "math_square_bracket", "math_round_bracket"])
      expect(kind(id).isClosed).toBe(false);
  });
});

describe("Head.kt", () => {
  test("the open head is today's chevron", () => {
    const head = headPaths("open", pt(100, 0), pt(1, 0), 4);
    expect(head.length).toBe(1);
    expect(head[0].role).toBe("HEAD");
    expect(pts(head[0].contours[0])).toEqual([pt(88, 7), pt(102, 0), pt(88, -7)]);
  });

  test("open and filled heads add HEAD / HEAD_FILLED paths", () => {
    const line = [polylinePath([pt(0, 0), pt(100, 0)])];
    const open = attachHeads(line, "none", "open", 2);
    expect(open.length).toBe(2);
    expect(open[1].role).toBe("HEAD");
    expect(pts(open[0].contours[0])[1]).toEqual(pt(100, 0));
    const filled = attachHeads(line, "filled", "filled", 2);
    expect(filled.map((p) => p.role)).toEqual(["STROKE_ONLY", "HEAD_FILLED", "HEAD_FILLED"]);
    expect(attachHeads(line, "none", "none", 2)).toBe(line);
  });

  test("a closed head stops the line at its back", () => {
    const out = attachHeads([polylinePath([pt(0, 0), pt(100, 0)])], "none", "hollow_triangle", 2);
    expect(pts(out[0].contours[0]).at(-1)).toEqual(pt(88, 0));
    expect(out[1].role).toBe("HEAD");
    expect(out[1].contours[0].start).toEqual(pt(100, 0));
  });

  test("a start head points backwards", () => {
    const out = attachHeads([polylinePath([pt(0, 0), pt(100, 0)])], "filled_diamond", "none", 2);
    expect(pts(out[0].contours[0])[0].x).toBeCloseTo(12 * 1.3, 9);
    expect(out[1].role).toBe("HEAD_FILLED");
    expect(out[1].contours[0].start).toEqual(pt(0, 0));
  });

  test("a curved end is trimmed along the curve", () => {
    const curve: Contour = { start: pt(0, 0), segs: [{ t: "C", c1: pt(0, 100), c2: pt(100, 100), end: pt(100, 0) }], closed: false };
    const out = attachHeads([{ contours: [curve], role: "STROKE_ONLY", fillRule: "nonzero" }], "none", "filled", 4);
    const seg = out[0].contours[0].segs[0];
    expect(Math.abs(vdist(seg.end, pt(100, 0)) - 14)).toBeLessThan(0.01);
    const on = Array.from({ length: 401 }, (_, i) => cubicAt(pt(0, 0), pt(0, 100), pt(100, 100), pt(100, 0), i / 400));
    expect(on.some((p) => vdist(p, seg.end) < 0.5)).toBe(true);
  });

  test("an arc takes heads", () => {
    const k = kind("arc");
    const g = k.build(rect(10, 20, 120, 80), params(k));
    const out = attachHeads(g.paths, "none", "filled", 2);
    expect(out.at(-1)?.role).toBe("HEAD_FILLED");
    const dir = vnorm(vsub(out[1].contours[0].start, pts(out[0].contours[0]).at(-1) ?? pt(0, 0)));
    expect(Number.isFinite(dir.x)).toBe(true);
  });
});

describe("FreePath.kt", () => {
  const curve: Contour = {
    start: pt(0, 0),
    segs: [
      { t: "C", c1: pt(0, 1), c2: pt(1, 1), end: pt(1, 0) },
      { t: "L", end: pt(0.5, -0.25) },
    ],
    closed: true,
  };
  const open = FreePath.lines([pt(0.125, 0.5), pt(0.75, 0.875)], false);

  test("svg path data round trips", () => {
    const back = FreePath.fromSvg(FreePath.toSvg([curve, open]));
    if (!back) throw new Error("null");
    expect(back.length).toBe(2);
    expect(back[0].closed).toBe(true);
    expect(back[1].closed).toBe(false);
    expect(back[0].segs[0].t).toBe("C");
    expect(allPoints(back[0])).toEqual(allPoints(curve));
    expect(allPoints(back[1])).toEqual(allPoints(open));
  });

  test("svg path data is compact", () => {
    expect(FreePath.toSvg([open])).toBe("M0.125,0.5 L0.75,0.875");
    expect(FreePath.toSvg([FreePath.lines([pt(0, 0), pt(1, 0), pt(1, 1)], true)])).toBe("M0,0 L1,0 L1,1 Z");
    expect(FreePath.toSvg([FreePath.lines([pt(0.000001, 12345678.5)], false)])).toBe("M1.0E-6,1.23456785E7");
  });

  test("bad path data reads as nothing", () => {
    expect(FreePath.fromSvg("")).toBeNull();
    expect(FreePath.fromSvg("L1,1")).toBeNull();
    expect(FreePath.fromSvg("M1,1 Q2,2 3,3")).toBeNull();
    expect(FreePath.fromSvg("M1")).toBeNull();
  });

  test("normalize and place are inverses", () => {
    const box = rect(10, 20, 200, 50);
    const back = FreePath.normalize(FreePath.place([curve], box), box);
    const want = allPoints(curve);
    const got = allPoints(back[0]);
    want.forEach((w, i) => expect(vdist(w, got[i])).toBeLessThan(1e-12));
  });

  test("bounds hug the curve, not its handles", () => {
    const arch: Contour = { start: pt(0, 0), segs: [{ t: "C", c1: pt(0, 100), c2: pt(100, 100), end: pt(100, 0) }], closed: false };
    const b = FreePath.bounds([arch]);
    if (!b) throw new Error("null");
    expect(Math.abs(bottom(b) - 75)).toBeLessThan(0.1);
    expect(b.y).toBeCloseTo(0, 9);
  });

  test("only one straight contour is a vertex list", () => {
    expect(FreePath.isVertexList([open])).toBe(true);
    expect(FreePath.isVertexList([curve])).toBe(false);
    expect(FreePath.isVertexList([open, open])).toBe(false);
  });
});
