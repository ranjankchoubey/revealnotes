import { deflateSync, inflateSync, strFromU8, strToU8, unzipSync } from "fflate";
import { mimeFor, type CanvasDoc, type CanvasItem } from "../format/xcanvas";
import type { PaperMode } from "../render/draw";
import { fromBase64, toBase64 } from "./export";
import type { Animation, Lesson } from "./reveal";

/**
 * What an exported file draws: the notes as parsed for drawing, without the source file (or its raw
 * XNotes JSON), so the export can be presented but not reopened or edited in XNotes.
 */
export interface ViewDoc {
  v: 1;
  format: CanvasDoc["format"];
  dpi: number;
  background: CanvasDoc["background"];
  pages: CanvasDoc["pages"];
  bounds: CanvasDoc["bounds"];
  /** Items without `raw`; number arrays packed as { $d: deltas in hundredths, s: stride }. */
  items: unknown[];
  /** Picture name -> data URL. */
  assets: Record<string, string>;
  /** Step of each item, in item order (0 = always shown). */
  stages: number[];
  names: [number, string][];
  paper: PaperMode;
  animation: Animation;
}

// Ribbon arrays are most of a file: hundredths of a px, each value stored as the step from the one
// [stride] back (x from x, y from y), so the deflated JSON stays near the size of the notes file.
function packNumbers(a: ArrayLike<number>, stride: number) {
  const d = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) d[i] = Math.round(a[i] * 100) - (i >= stride ? Math.round(a[i - stride] * 100) : 0);
  return { $d: d, s: stride };
}

function unpackNumbers(d: number[], stride: number) {
  const acc = new Array<number>(d.length);
  const out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) {
    acc[i] = d[i] + (i >= stride ? acc[i - stride] : 0);
    out[i] = acc[i] / 100;
  }
  return out;
}

function pack(v: unknown, key = ""): unknown {
  if (v instanceof Float64Array || v instanceof Float32Array) return packNumbers(v, key === "centers" ? 2 : 1);
  if (Array.isArray(v)) return v.map((x) => pack(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "raw") out[k] = pack(x, k);
    return out;
  }
  return v;
}

function unpack(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === "object") {
    const p = v as { $d?: number[]; s?: number };
    if (Array.isArray(p.$d)) return unpackNumbers(p.$d, p.s ?? 1);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = unpack(x);
    return out;
  }
  return v;
}

export const encodeView = (v: ViewDoc): string => toBase64(deflateSync(strToU8(JSON.stringify(v)), { level: 9 }));
export const decodeView = (s: string): ViewDoc => JSON.parse(strFromU8(inflateSync(fromBase64(s)))) as ViewDoc;

export function toView(doc: CanvasDoc, bytes: Uint8Array, ids: string[], lesson: Lesson): ViewDoc {
  const used = new Set(doc.items.flatMap((it) => (it.kind === "image" ? [it.asset] : [])));
  const assets: Record<string, string> = {};
  if (used.size) {
    const entries = unzipSync(bytes, { filter: (f) => used.has(f.name) });
    for (const [name, data] of Object.entries(entries)) assets[name] = `data:${mimeFor(name)};base64,${toBase64(data)}`;
  }
  return {
    v: 1,
    format: doc.format,
    dpi: doc.dpi,
    background: doc.background,
    pages: doc.pages,
    bounds: doc.bounds,
    items: doc.items.map((it) => pack(it)),
    assets,
    stages: ids.map((id) => lesson.stages.get(id) ?? 0),
    names: [...lesson.names],
    paper: lesson.paper,
    animation: lesson.animation,
  };
}

export function fromView(name: string, v: ViewDoc): { doc: CanvasDoc; ids: string[]; lesson: Lesson } {
  const items = v.items.map((it) => ({ ...(unpack(it) as object), raw: {} }) as CanvasItem);
  const ids = items.map((_, i) => String(i));
  const doc: CanvasDoc = {
    fileName: name,
    manifestSha256: "",
    format: v.format,
    version: 1,
    dpi: v.dpi,
    background: v.background,
    pages: v.pages,
    items,
    assets: new Map(Object.entries(v.assets)),
    pdfBytes: null,
    pdf: null,
    bounds: v.bounds,
    warnings: [],
  };
  const lesson: Lesson = {
    stages: new Map(ids.map((id, i) => [id, v.stages[i] ?? 0])),
    names: new Map(v.names),
    base: null,
    paper: v.paper,
    animation: v.animation,
  };
  return { doc, ids, lesson };
}
