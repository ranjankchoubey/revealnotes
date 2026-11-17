// Assertions copied from XNotes app/src/test/.../StrokeEngineTest.kt to pin the port to the original.
import { describe, expect, test } from "bun:test";
import { buildRibbon, halfWidth, SMOOTH_LEN, type BuildParams } from "../src/engine/strokeEngine";

const width = (bw: number, pe: boolean, m: number, ds: number, p: number, ty: number) => 2 * halfWidth(bw, pe, m, ds, p, ty);

function build(pts: [number, number, number?][], baseWidth: number, pressureEnabled: boolean, m: number, ds: number, o: Partial<BuildParams> = {}) {
  return buildRibbon({
    x: Float64Array.from(pts, (q) => q[0]),
    y: Float64Array.from(pts, (q) => q[1]),
    p: Float64Array.from(pts, (q) => q[2] ?? 1),
    t: null, widthFactor: null, baseWidth, pressureEnabled, m, ds,
    speedStrength: 0, taperEnabled: false, taperMinFactor: 0, speedScale: 1, smooth: true, holdEnds: false,
    smoothScale: 1, speedTop: 0.6, speedSmoothing: 0.25, ...o,
  });
}
const close = (a: number, b: number, eps: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("width formula", () => {
  test("penWidth", () => {
    close(width(3, true, 0.35, 0, 0, 0), 1.05, 1e-9);
    close(width(3, true, 0.35, 0, 1, 0), 3.0, 1e-9);
  });
  test("calligraphyWidth", () => {
    close(width(6, true, 0.4, 0.6, 0, -1), 0.96, 1e-9);
    close(width(6, true, 0.4, 0.6, 1, 1), 9.6, 1e-9);
  });
  test("pressureDisabledIsFullWidth", () => {
    close(width(4, false, 0.1, 0, 0, 0), 4, 1e-9);
    close(width(4, false, 0.1, 0, 1, 0), 4, 1e-9);
  });
  test("directionFloorClamps", () => close(width(10, false, 1, 0.95, 1, -1), 1, 1e-9));
});

describe("geometry", () => {
  test("smoothingLagIsADistanceNotASampleCount", () => {
    const gd = build(range(0, 60).map((i) => [i * 1.0, 0, 1]), 3, false, 1, 0);
    const gs = build(range(0, 20).map((i) => [i * 3.0, 0, 1]), 3, false, 1, 0);
    close(gd.centers[gd.centers.length - 2], 60 - SMOOTH_LEN, 1e-6);
    close(gs.centers[gs.centers.length - 2], 60 - SMOOTH_LEN, 1e-6);
  });
  test("singleSampleIsOneDisc", () => {
    const g = build([[10, 20, 1]], 3, true, 0.35, 0);
    expect(g.halfWidths.length).toBe(1);
    close(g.centers[0], 10, 1e-6);
    close(g.centers[1], 20, 1e-6);
    close(g.halfWidths[0], 1.5, 1e-6);
  });
  test("emptyInput", () => expect(build([], 3, true, 0.35, 0).halfWidths.length).toBe(0));
});

describe("taper", () => {
  const pts = range(0, 10).map((i) => [i * 10, 0, 1] as [number, number, number]);
  test("taperSpansTheWholeStroke", () => {
    const g = build(pts, 4, false, 1, 0, { taperEnabled: true, smooth: false });
    close(g.halfWidths[0], 2, 1e-6);
    close(g.halfWidths[5], 1, 1e-6);
    close(g.halfWidths[10], 0, 1e-6);
    for (let i = 0; i < 10; i++) expect(g.halfWidths[i]).toBeGreaterThan(g.halfWidths[i + 1]);
  });
  test("taperIgnoresVeryShortStrokes", () => {
    close(build([[0, 0, 1], [3, 0, 1]], 4, false, 1, 0, { taperEnabled: true }).halfWidths[0], 2, 1e-6);
  });
  test("taperBottomsOutAtTheTipWidthFloor", () => {
    const g = build(pts, 4, false, 1, 0, { taperEnabled: true, taperMinFactor: 0.25, smooth: false });
    close(g.halfWidths[0], 2, 1e-6);
    close(g.halfWidths[10], 0.5, 1e-6);
    close(g.halfWidths[5], 1.25, 1e-6);
  });
});

describe("calligraphy", () => {
  test("theSameGestureAtAnyZoomIsAScaledCopy", () => {
    const ds = 0.6, k = 0.25;
    const gesture: [number, number, number][] = [
      ...range(0, 14).map((i) => [i * 1.4, -i * 1.4, 1] as [number, number, number]),
      ...range(1, 30).map((i) => [19.6 + i * 1.4, -19.6 + i * 1.4, 1] as [number, number, number]),
    ];
    const full = build(gesture, 6, false, 1, ds);
    const zoomed = build(gesture.map(([x, y, p]) => [x * k, y * k, p]), 6 * k, false, 1, ds, { smoothScale: k });
    for (let i = 0; i < full.halfWidths.length; i++) {
      close(zoomed.halfWidths[i], full.halfWidths[i] * k, 1e-6);
      close(zoomed.centers[2 * i], full.centers[2 * i] * k, 1e-6);
    }
    expect(Math.max(...full.halfWidths)).toBeGreaterThan(1.8 * Math.min(...full.halfWidths));
  });
});
