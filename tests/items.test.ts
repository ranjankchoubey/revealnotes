import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { loadDocument, type ImageItem, type ShapeItem, type StrokeItem, type TapeItem } from "../src/format/xcanvas";
import { objectIds } from "../src/lesson/ids";
import { applyReveal, newLesson, pairingDoubt, serializeReveal } from "../src/lesson/reveal";
import { withoutPdf } from "../src/lesson/export";
import { hitItem } from "../src/render/hit";

const SAMPLE = new URL("./fixtures/untitled_1.xcanvas", import.meta.url).pathname;
const NOTE = new URL("./fixtures/untitled_2.xnote", import.meta.url).pathname;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function canvas(items: unknown[], extra: Record<string, Uint8Array> = {}) {
  const m = { format: "xcanvas", version: 1, dpi: 150, background: { pattern: "grid" }, items };
  return zipSync({ "manifest.json": strToU8(JSON.stringify(m)), ...extra });
}

const ink = [0, 0, 0, 255];

describe("XNotes items beyond pen strokes", () => {
  test("a turned rectangle is drawn turned, its label centred and turned with it", async () => {
    const doc = await loadDocument("t.xcanvas", canvas([
      {
        kind: "shape", shape: "polygon", start: [0, 0], end: [10, 10], stroke_rgba: ink, stroke_width: 2, fill_rgba: null,
        points: [[0, 0], [1, 1]], geom: "rectangle", rect: [100, 100, 200, 100], angle: Math.PI / 2,
        label: { text: "Hi", rgba: ink, point_size: 13 },
      },
    ]));
    const s = doc.items[0] as ShapeItem;
    expect(s.shapeKind).toBe("rectangle");
    // 200×100 about (200, 150), turned a quarter: 100 wide, 200 tall.
    expect(s.bounds.minX).toBeCloseTo(150 - 1, 3);
    expect(s.bounds.maxY).toBeCloseTo(250 + 1, 3);
    expect(s.label!.cx).toBeCloseTo(200, 6);
    expect(s.label!.cy).toBeCloseTo(150, 6);
    expect(s.label!.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(doc.warnings).toEqual([]);
  });

  test("an arrow gets its head, a connector its heads and a gap for its label", async () => {
    const doc = await loadDocument("a.xcanvas", canvas([
      { kind: "shape", shape: "arrow", start: [0, 0], end: [300, 0], stroke_rgba: ink, stroke_width: 2, fill_rgba: null },
      {
        kind: "shape", shape: "polyline", start: [0, 100], end: [400, 100], stroke_rgba: ink, stroke_width: 2, fill_rgba: null,
        points: [[0, 100], [400, 100]], head_end: "filled", connector: { from: {}, to: {} },
        label: { text: "flows", rgba: ink, point_size: 13 },
      },
    ]));
    const [arrow, conn] = doc.items as ShapeItem[];
    expect(arrow.paths.some((p) => p.role === "HEAD" || p.role === "HEAD_FILLED")).toBe(true);
    expect(conn.paths.some((p) => p.role === "HEAD_FILLED")).toBe(true);
    const line = conn.paths.find((p) => p.role === "STROKE_ONLY")!;
    // The line breaks round the label in its middle: two runs.
    expect(line.contours.length).toBe(2);
    expect(conn.label!.cx).toBeCloseTo(200, 0);
  });

  test("a kind this port does not know falls back to the outline older readers get", async () => {
    const doc = await loadDocument("u.xcanvas", canvas([
      { kind: "shape", shape: "polygon", start: [0, 0], end: [10, 10], stroke_rgba: ink, stroke_width: 2, fill_rgba: null, points: [[0, 0], [10, 0], [10, 10]], geom: "from_the_future", rect: [0, 0, 10, 10], angle: 0.3 },
    ]));
    expect((doc.items[0] as ShapeItem).paths[0].contours[0].segs.length).toBe(2);
  });

  test("images keep their turn, flip, orientation and crop", async () => {
    const doc = await loadDocument("i.xcanvas", canvas(
      [{ kind: "image", asset: "assets/image-1.png", rect: [0, 0, 100, 50], angle: Math.PI / 2, orientation: 90, flip: "x", part: [0.25, 0, 0.5, 1] }],
      { "assets/image-1.png": PNG },
    ));
    const im = doc.items[0] as ImageItem;
    expect(im.orientation).toBe(90);
    expect(im.flip).toEqual({ x: true, y: false });
    expect(im.part).toEqual([0.25, 0, 0.5, 1]);
    // Turned a quarter about (50, 25): 50 wide, 100 tall.
    expect(im.bounds.maxX - im.bounds.minX).toBeCloseTo(50, 6);
    expect(im.bounds.maxY - im.bounds.minY).toBeCloseTo(100, 6);
    expect(doc.warnings).toEqual([]);
  });

  test("tape: straight, rectangle and freehand bodies, printed patterns, hit inside only", async () => {
    const doc = await loadDocument("tape.xcanvas", canvas([
      { kind: "tape", mode: "straight", points: [[0, 0], [200, 0]], width: 36, rgba: [255, 200, 0, 255], pattern: "stripes" },
      { kind: "tape", mode: "rectangle", points: [[0, 100], [200, 100]], width: 40, rgba: [40, 40, 40, 255], pattern: "grid" },
      { kind: "tape", mode: "freehand", points: [[0, 200], [100, 220], [200, 200]], width: 30, rgba: [200, 220, 255, 255], pattern: "dots" },
    ]));
    const [a, b, c] = doc.items as TapeItem[];
    expect(a.body.length).toBe(1);
    expect(a.bounds.minX).toBeCloseTo(-18, 6);
    expect(a.marks.length).toBeGreaterThan(5);
    // Light tape prints darker; dark tape prints lighter.
    expect(a.printColor[0]).toBeLessThan(255);
    expect(b.printColor[0]).toBeGreaterThan(40);
    expect(c.body.length).toBe(2);
    expect(hitItem(a, 100, 0, 0)).toBe(true);
    expect(hitItem(a, 100, 30, 0)).toBe(false);
    expect(doc.warnings).toEqual([]);
  });

  test("neon and room-cut strokes are drawn, not warned about", async () => {
    const entries = unzipSync(new Uint8Array(readFileSync(SAMPLE)));
    const m = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    const s = m.items[0];
    const neon = { ...s, config: { ...s.config, neon: true, neon_strength: 1 } };
    const box = (await loadDocument("x.xcanvas", canvas([s]))).items[0].bounds;
    const midX = (box.minX + box.maxX) / 2;
    const cut = { ...s, cuts: [[midX, 0, 1, 0]] };
    const doc = await loadDocument("n.xcanvas", canvas([neon, cut]));
    const [n, c] = doc.items as StrokeItem[];
    expect(n.neon!.strength).toBe(1);
    expect(n.neon!.wide).toBeGreaterThan(n.neon!.tight);
    // Everything right of the cut is gone, so the box ends at it.
    expect(c.bounds.maxX).toBeCloseTo(midX, 6);
    expect(doc.warnings).toEqual([]);
  });
});

describe("steps for the wrong notes", () => {
  test("steps from other notes are doubted; the same notes, even edited a little, are not", async () => {
    const a = await loadDocument("untitled_1.xcanvas", new Uint8Array(readFileSync(SAMPLE)));
    const b = await loadDocument("untitled_2.xnote", new Uint8Array(readFileSync(NOTE)));
    const idsA = objectIds(a);
    const idsB = objectIds(b);
    const fileA = serializeReveal(a, idsA, newLesson(idsA), true);
    const wrong = applyReveal(b, idsB, fileA);
    expect(pairingDoubt(wrong.report, idsB.length)).not.toBeNull();
    const right = applyReveal(a, idsA, fileA);
    expect(pairingDoubt(right.report, idsA.length)).toBeNull();
    // One stroke erased out of eight: still the same notes.
    const fewer = { ...fileA, manifest_sha256: "changed" };
    const edited = applyReveal(a, idsA.slice(1), fewer);
    expect(pairingDoubt(edited.report, idsA.length - 1)).toBeNull();
  });
});

describe("export", () => {
  test("the source PDF is left out of the embedded notes, the manifest untouched", () => {
    const manifest = strToU8('{"format":"xnote","version":1,"pages":[]}');
    const z = zipSync({ "manifest.json": manifest, "assets/source.pdf": new Uint8Array(5000) });
    const out = unzipSync(withoutPdf(z));
    expect(out["assets/source.pdf"]).toBeUndefined();
    expect(new TextDecoder().decode(out["manifest.json"])).toBe(new TextDecoder().decode(manifest));
  });

  test("PDF pages are read with their page and turn", async () => {
    const note = { format: "xnote", version: 1, pages: [{ width: 100, height: 200, pdf_page: 2, pdf_turn: 1, items: [] }, { width: 100, height: 200, items: [] }] };
    const doc = await loadDocument("p.xnote", zipSync({ "manifest.json": strToU8(JSON.stringify(note)), "assets/source.pdf": new Uint8Array([37, 80, 68, 70]) }));
    expect(doc.pages![0].pdfPage).toBe(2);
    expect(doc.pages![0].pdfTurn).toBe(1);
    expect(doc.pages![1].pdfPage).toBeNull();
    expect(doc.pdfBytes!.length).toBe(4);
    expect(doc.warnings).toEqual([]);
  });
});
