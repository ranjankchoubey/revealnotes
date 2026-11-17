// Test fixtures for a visual check: every shape kind, labels, connectors, images, tape, neon, cuts,
// and an .xnote with a PDF page. Writes to .tmp-test/.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { ALL_KINDS } from "../src/shapes/kinds";

mkdirSync(".tmp-test", { recursive: true });
const sample = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync("tests/fixtures/untitled_1.xcanvas")))["manifest.json"]));
const blue = [0, 120, 255, 255];
const items: unknown[] = [];
const cols = 10;
ALL_KINDS.forEach((k, i) => {
  const x = 40 + (i % cols) * 170;
  const y = 40 + Math.floor(i / cols) * 170;
  const box = [x, y, 130, 110];
  const base = { kind: "shape", stroke_rgba: blue, stroke_width: 3, fill_rgba: k.isClosed ? [180, 210, 255, 255] : null };
  if (k.isEndpointShape) items.push({ ...base, shape: k.id, start: [x, y + 110], end: [x + 130, y] });
  else if (k.isFree) items.push({ ...base, kind: k.id === "glyphs" || k.id === "fill" ? k.id : "shape", shape: k.id, start: [x, y], end: [x + 130, y + 110], points: [[x, y + 110], [x + 40, y], [x + 90, y + 80], [x + 130, y + 10]] });
  else items.push({ ...base, shape: "polygon", start: [x, y], end: [x + 130, y + 110], points: [[x, y], [x + 130, y], [x + 130, y + 110]], geom: k.id, rect: box });
});
const row = 40 + Math.ceil(ALL_KINDS.length / cols) * 170 + 40;
items.push(
  { kind: "shape", shape: "polygon", start: [0, 0], end: [1, 1], stroke_rgba: [200, 0, 80, 255], stroke_width: 3, fill_rgba: [255, 220, 230, 255], points: [[0, 0], [1, 1]], geom: "rounded_rect", rect: [60, row, 260, 120], angle: 0.35, label: { text: "A turned box with a label that wraps", rgba: [0, 0, 0, 255], point_size: 12, font_face: "sans" } },
  { kind: "shape", shape: "polygon", start: [0, 0], end: [1, 1], stroke_rgba: [0, 150, 80, 255], stroke_width: 3, fill_rgba: [200, 255, 220, 255], points: [[0, 0], [1, 1]], flip_geom: "right_triangle", flip: "x", rect: [400, row, 160, 120] },
  { kind: "shape", shape: "arrow", start: [620, row + 120], end: [860, row], stroke_rgba: [0, 0, 0, 255], stroke_width: 3, fill_rgba: null, label: { text: "slope", rgba: [0, 0, 0, 255], point_size: 12 } },
  { kind: "shape", shape: "polyline", start: [900, row], end: [1200, row + 120], stroke_rgba: [120, 0, 200, 255], stroke_width: 3, fill_rgba: null, points: [[900, row], [1050, row], [1050, row + 120], [1200, row + 120]], head_start: "hollow_diamond", head_end: "filled", connector: { from: {}, to: {} }, label: { text: "connector", rgba: [120, 0, 200, 255], point_size: 12 } },
  { kind: "shape", shape: "rectangle", start: [1260, row], end: [1460, row + 120], stroke_rgba: [255, 0, 200, 255], stroke_width: 4, fill_rgba: null, neon: true, neon_strength: 0.8 },
  { kind: "shape", shape: "ellipse", start: [1500, row], end: [1700, row + 120], stroke_rgba: [0, 0, 0, 255], stroke_width: 3, fill_rgba: null, dashed: true, dash_length: 14, dash_gap: 8 },
);
const row2 = row + 200;
const img = { kind: "image", asset: "assets/image-1.png" };
items.push(
  { ...img, rect: [60, row2, 192, 192] },
  { ...img, rect: [300, row2, 192, 192], angle: 0.4 },
  { ...img, rect: [540, row2, 192, 192], flip: "x" },
  { ...img, rect: [780, row2, 192, 96], part: [0, 0.25, 1, 0.5] },
  { ...img, rect: [1020, row2, 192, 192], orientation: 90 },
);
const row3 = row2 + 260;
const strokes = sample.items.filter((s: { kind: string }) => s.kind === "stroke");
const shift = (s: { samples: number[][] }, dx: number, dy: number) => ({ ...s, samples: s.samples.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)]) });
const s0 = strokes.reduce((a: { samples: unknown[] }, b: { samples: unknown[] }) => (b.samples.length > a.samples.length ? b : a));
const minX = Math.min(...s0.samples.map((p: number[]) => p[0]));
const minY = Math.min(...s0.samples.map((p: number[]) => p[1]));
items.push(
  { ...shift(s0, 60 - minX, row3 - minY), config: { ...s0.config, rgba: [0, 255, 200, 255], base_width: 6, neon: true, neon_strength: 0.9 } },
  { ...shift(s0, 700 - minX, row3 - minY), cuts: [[700 + (Math.max(...s0.samples.map((p: number[]) => p[0])) - minX) / 2, 0, 1, 0]] },
  { kind: "tape", mode: "straight", points: [[1100, row3 + 40], [1500, row3 + 40]], width: 40, rgba: [255, 214, 102, 255], pattern: "stripes" },
  { kind: "tape", mode: "rectangle", points: [[1100, row3 + 120], [1500, row3 + 140]], width: 50, rgba: [60, 60, 70, 255], pattern: "grid" },
  { kind: "tape", mode: "freehand", points: [[1100, row3 + 220], [1250, row3 + 260], [1400, row3 + 200], [1500, row3 + 240]], width: 34, rgba: [190, 220, 255, 255], pattern: "dots" },
);
const manifest = { format: "xcanvas", version: 1, dpi: 150, background: { pattern: "grid" }, items };
writeFileSync(".tmp-test/allkinds.xcanvas", zipSync({
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "assets/image-1.png": new Uint8Array(readFileSync("public/icon-192.png")),
}));

// A one-page PDF with a heading and a box (pdf.js rebuilds the cross-reference table itself).
const content = "BT /F1 48 Tf 72 700 Td (PDF backdrop page) Tj ET 0 0 1 RG 4 w 72 400 300 200 re S";
const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${content.length} >> stream
${content}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;
const w = (612 / 72) * 150;
const h = (792 / 72) * 150;
const note = {
  format: "xnote", version: 1,
  pages: [
    { width: w, height: h, pdf_page: 0, items: [shift(s0, 200 - minX, 300 - minY)] },
    { width: h, height: w, pdf_page: 0, pdf_turn: 1, items: [] },
  ],
};
writeFileSync(".tmp-test/pdfnote.xnote", zipSync({ "manifest.json": strToU8(JSON.stringify(note)), "assets/source.pdf": strToU8(pdf) }));
console.log("wrote .tmp-test/allkinds.xcanvas and .tmp-test/pdfnote.xnote");
