// Test fixture generator: a tall canvas (8 stacked copies of the sample) plus a reveal file, one step per copy.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { loadDocument } from "../src/format/xcanvas";
import { objectIds } from "../src/lesson/ids";
import { newLesson, serializeReveal } from "../src/lesson/reveal";

const entries = unzipSync(new Uint8Array(readFileSync(new URL("../tests/fixtures/untitled_1.xcanvas", import.meta.url).pathname)));
const m = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
const copies = 8;
const items: unknown[] = [];
for (let k = 0; k < copies; k++) {
  for (const it of m.items) {
    const c = JSON.parse(JSON.stringify(it));
    c.samples = c.samples.map((s: number[]) => [s[0], +(s[1] + k * 1400).toFixed(2), s[2]]);
    items.push(c);
  }
}
m.items = items;
const bytes = zipSync({ "manifest.json": strToU8(JSON.stringify(m)) });
const doc = await loadDocument("lecture.xcanvas", bytes);
const ids = objectIds(doc);
const lesson = newLesson(ids);
ids.forEach((id, i) => lesson.stages.set(id, Math.floor(i / m.items.length * copies) + 1));
for (let k = 1; k <= copies; k++) lesson.names.set(k, `Part ${k}`);
const out = new URL("../.tmp-test/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
writeFileSync(out + "lecture.xcanvas", bytes);
writeFileSync(out + "lecture.reveal.json", JSON.stringify(serializeReveal(doc, ids, lesson, false), null, 2));
console.log("wrote", out, doc.items.length, "items", doc.bounds);
