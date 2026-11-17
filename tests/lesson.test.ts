import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { loadDocument, loadXCanvas } from "../src/format/xcanvas";
import { objectIds } from "../src/lesson/ids";
import { applyReveal, compactStages, newLesson, serializeReveal } from "../src/lesson/reveal";

describe("compactStages", () => {
  test("closes gaps, names follow their step, active step kept even when empty", () => {
    const stages = new Map([["a", 0], ["b", 1], ["c", 3], ["d", 5]]);
    const names = new Map([[3, "Example"], [7, "gone"]]);
    const r = compactStages({ stages, names }, 4);
    expect([...r.steps.stages]).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 4]]);
    expect([...r.steps.names]).toEqual([[2, "Example"]]);
    expect(r.keep).toBe(3);
    const same = { stages: new Map([["a", 1], ["b", 2]]), names: new Map([[1, "x"]]) };
    expect(compactStages(same, 3).steps).toBe(same);
  });
});

describe("xnote (synthetic, built from the sample's strokes)", () => {
  test("pages stack vertically and page-local strokes are offset", async () => {
    const entries = unzipSync(new Uint8Array(readFileSync(new URL("./fixtures/untitled_1.xcanvas", import.meta.url).pathname)));
    const canvas = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    const stroke = canvas.items[0];
    const note = {
      format: "xnote", version: 1, dpi: 150, style: { pattern: "lines" },
      pages: [
        { width: 1240, height: 1754, items: [stroke] },
        { width: 1240, height: 1754, items: [stroke, { kind: "text", pos: [10, 20], width: 400, text: "Hello world", point_size: 13 }] },
      ],
    };
    const doc = await loadDocument("n.xnote", zipSync({ "manifest.json": strToU8(JSON.stringify(note)) }));
    expect(doc.format).toBe("xnote");
    expect(doc.pages!.length).toBe(2);
    expect(doc.pages![1].bounds.minY).toBe(1754 + 48);
    expect(doc.pages![0].pattern).toBe("lines");
    const [s0, s1, text] = doc.items;
    expect(s1.bounds.minY - s0.bounds.minY).toBeCloseTo(1754 + 48, 6);
    expect(text.kind).toBe("text");
    expect(text.bounds.minY).toBe(1754 + 48 + 20);
    // Same stroke on two pages must still get distinct ids.
    const ids = objectIds(doc);
    expect(new Set(ids).size).toBe(3);
    expect(doc.warnings.some((w) => w.includes("experimental"))).toBe(true);
  });
});

describe("xnote (real file from XNotes)", () => {
  test("one landscape page, grid, 25 strokes and 2 real shapes", async () => {
    const doc = await loadDocument("untitled_2.xnote", new Uint8Array(readFileSync(new URL("./fixtures/untitled_2.xnote", import.meta.url).pathname)));
    expect(doc.pages!.length).toBe(1);
    expect(doc.pages![0].pattern).toBe("grid");
    expect(doc.pages![0].bounds.maxX).toBeCloseTo(1753.94, 1);
    expect(doc.items.filter((i) => i.kind === "stroke").length).toBe(25);
    const shapes = doc.items.filter((i) => i.kind === "shape");
    expect(shapes.length).toBe(2);
    const [rect, tri] = shapes as Extract<typeof shapes[number], { kind: "shape" }>[];
    expect(rect.points!.length).toBe(4);
    expect(tri.points!.length).toBe(3);
    expect(tri.closed).toBe(true);
    expect(doc.warnings).toEqual(["Notebook (.xnote) support is experimental. Please compare with XNotes."]);
  });
});

describe("step names", () => {
  test("round-trip through reveal.json", async () => {
    const doc = await loadXCanvas("untitled_1.xcanvas", new Uint8Array(readFileSync(new URL("./fixtures/untitled_1.xcanvas", import.meta.url).pathname)));
    const ids = objectIds(doc);
    const lesson = newLesson(ids);
    lesson.stages.set(ids[0], 1);
    lesson.stages.set(ids[1], 2);
    lesson.names.set(2, "Brute force");
    lesson.names.set(9, "unused step is not saved");
    const file = JSON.parse(JSON.stringify(serializeReveal(doc, ids, lesson, true)));
    expect(file.steps).toEqual({ "2": { name: "Brute force" } });
    expect([...applyReveal(doc, ids, file).lesson.names]).toEqual([[2, "Brute force"]]);
  });
});

const SAMPLE = new URL("./fixtures/untitled_1.xcanvas", import.meta.url).pathname;

function rezip(mutate: (m: { items: unknown[] }) => void): Uint8Array {
  const entries = unzipSync(new Uint8Array(readFileSync(SAMPLE)));
  const m = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
  mutate(m);
  return zipSync({ ...entries, "manifest.json": strToU8(JSON.stringify(m)) });
}

describe("sample document", () => {
  test("loads all 8 pen strokes", async () => {
    const doc = await loadXCanvas("untitled_1.xcanvas", new Uint8Array(readFileSync(SAMPLE)));
    expect(doc.items.length).toBe(8);
    expect(doc.items.every((i) => i.kind === "stroke")).toBe(true);
    expect(doc.warnings).toEqual([]);
    expect(doc.background.pattern).toBe("grid");
    expect(doc.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ids are unique and survive reordering", async () => {
    const a = await loadXCanvas("a.xcanvas", new Uint8Array(readFileSync(SAMPLE)));
    const b = await loadXCanvas("a.xcanvas", rezip((m) => m.items.reverse()));
    const ia = objectIds(a);
    const ib = objectIds(b);
    expect(new Set(ia).size).toBe(8);
    expect([...ib].reverse()).toEqual(ia);
  });

  test("ids ignore group/locked changes", async () => {
    const a = await loadXCanvas("a.xcanvas", new Uint8Array(readFileSync(SAMPLE)));
    const b = await loadXCanvas("a.xcanvas", rezip((m) => ((m.items[0] as Record<string, unknown>).group = 3)));
    expect(objectIds(b)).toEqual(objectIds(a));
  });

  test("save/reopen round trip; reorder keeps stages; edits are reported", async () => {
    const doc = await loadXCanvas("untitled_1.xcanvas", new Uint8Array(readFileSync(SAMPLE)));
    const ids = objectIds(doc);
    const lesson = newLesson(ids);
    ids.forEach((id, i) => lesson.stages.set(id, i % 4));
    const json = JSON.parse(JSON.stringify(serializeReveal(doc, ids, lesson, true)));

    const same = applyReveal(doc, ids, json);
    expect(same.report).toMatchObject({ docChanged: false, matched: 8, added: 0, missing: [] });
    expect([...same.lesson.stages]).toEqual([...lesson.stages]);

    const reordered = await loadXCanvas("untitled_1.xcanvas", rezip((m) => m.items.reverse()));
    const r2 = applyReveal(reordered, objectIds(reordered), json);
    expect(r2.report.docChanged).toBe(true);
    expect(r2.report.matched).toBe(8);
    for (const id of ids) expect(r2.lesson.stages.get(id)).toBe(lesson.stages.get(id));

    const edited = await loadXCanvas("untitled_1.xcanvas", rezip((m) => {
      const s = m.items[1] as { samples: number[][] };
      s.samples[0][0] += 5;
      m.items.push(JSON.parse(JSON.stringify(m.items[2])));
      (m.items[m.items.length - 1] as { samples: number[][] }).samples[0][1] += 1;
    }));
    const r3 = applyReveal(edited, objectIds(edited), json);
    expect(r3.report).toMatchObject({ docChanged: true, matched: 7, added: 2 });
    expect(r3.report.missing).toEqual([ids[1]]);

    // Orphans are preserved unless discarded.
    const kept = serializeReveal(edited, objectIds(edited), r3.lesson, true);
    expect(kept.objects[ids[1]]).toBeDefined();
    const dropped = serializeReveal(edited, objectIds(edited), r3.lesson, false);
    expect(dropped.objects[ids[1]]).toBeUndefined();
  });
});
