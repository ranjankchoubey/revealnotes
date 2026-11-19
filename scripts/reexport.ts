// Upgrades exported lesson files in place: the current player, view-only data (the notes file inside an
// older export is replaced by drawing data) and the watermark.
// Usage: bun scripts/reexport.ts <file.html>... [--watermark "@handle"]
import { readFile, writeFile } from "node:fs/promises";
import { loadDocument } from "../src/format/xcanvas";
import { objectIds } from "../src/lesson/ids";
import { applyReveal } from "../src/lesson/reveal";
import { EMBED_ID, META_ID, fromBase64, lessonHtml, type EmbeddedLesson, type LessonMeta } from "../src/lesson/export";
import { decodeView, encodeView, toView } from "../src/lesson/viewdoc";
import { getSettings } from "../src/ui/settings";

const args = process.argv.slice(2);
const wi = args.indexOf("--watermark");
const watermark = (wi >= 0 ? args.splice(wi, 2)[1] : getSettings().watermark).trim();
if (!args.length) {
  console.error('Usage: bun scripts/reexport.ts <file.html>... [--watermark "@handle"]');
  process.exit(1);
}

const built = await Bun.build({
  entrypoints: ["./src/player.tsx"],
  naming: "[name].[ext]",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const js = await built.outputs.find((o) => o.path.endsWith(".js"))!.text();
const css = await built.outputs.find((o) => o.path.endsWith(".css"))!.text();

function jsonScript<T>(html: string, id: string): T | null {
  const m = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
  return m ? (JSON.parse(m[1]) as T) : null;
}

for (const file of args) {
  const html = await readFile(file, "utf8");
  const data = jsonScript<EmbeddedLesson>(html, EMBED_ID);
  if (!data) {
    console.error(`  ! ${file}: not a RevealNotes export, skipped`);
    continue;
  }
  const meta = jsonScript<LessonMeta>(html, META_ID) ?? undefined;
  let view = data.view;
  let paper = data.paper;
  if (!view) {
    if (!data.xcanvas || !data.reveal) throw new Error(`${file}: no notes inside`);
    const bytes = fromBase64(data.xcanvas);
    const doc = await loadDocument(data.name, bytes);
    const ids = objectIds(doc);
    const lesson = applyReveal(doc, ids, data.reveal).lesson;
    lesson.paper = paper = data.reveal.paper === "dark" ? "dark" : "light";
    view = encodeView(toView(doc, bytes, ids, lesson));
  }
  paper ??= decodeView(view).paper;
  const next: EmbeddedLesson = { name: data.name, view, paper, pdf: data.pdf, presenter: data.presenter, watermark: watermark || undefined };
  const out = lessonHtml(next, js, css, meta);
  await writeFile(file, out);
  console.log(`  ${file}: ${(html.length / 1024).toFixed(0)} KB -> ${(out.length / 1024).toFixed(0)} KB${data.view ? "" : " (now view only)"}`);
}
