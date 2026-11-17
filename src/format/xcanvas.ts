import { unzipSync } from "fflate";
import { DEFAULT_SPEED_SMOOTHING, SPEED_HI, buildRibbon, speedWidths, type BuildParams, type RibbonGeometry } from "../engine/strokeEngine";
import { cyrb53 } from "../lesson/ids";

export type Rgba = [number, number, number, number];

export interface Background {
  pattern: "none" | "lines" | "dots" | "grid";
  patternColor: Rgba;
  spacing: number;
  paperColor: Rgba | null;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface ItemBase {
  /** Position in document order (z-order; pages in order for .xnote). */
  index: number;
  /** Page number for .xnote items; undefined on a canvas. */
  page?: number;
  /** Original JSON, untouched. */
  raw: Record<string, unknown>;
  bounds: Bounds;
}

export interface StrokeItem extends ItemBase {
  kind: "stroke";
  tool: string;
  color: Rgba;
  /** 0..1 alpha multiplier applied at composite time. */
  alpha: number;
  blend: GlobalCompositeOperation;
  dashed: { width: number; on: number; gap: number } | null;
  ribbon: RibbonGeometry;
  /** Features drawn without their exact XNotes effect (neon glow, cuts). */
  approx: string[];
}

export interface ImageItem extends ItemBase {
  kind: "image";
  asset: string;
  rect: [number, number, number, number];
  approx: string[];
}

export interface OtherItem extends ItemBase {
  kind: "other";
  rawKind: string;
}

export interface TextItem extends ItemBase {
  kind: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  /** Content px. */
  fontSize: number;
  font: string;
  color: Rgba;
  lines: string[];
  lineHeight: number;
}

export type CanvasItem = StrokeItem | ImageItem | TextItem | OtherItem;

/** One page of an .xnote, placed in document coordinates. */
export interface PageInfo {
  bounds: Bounds;
  /** null = theme paper. */
  color: Rgba | null;
  pattern: Background["pattern"];
  patternColor: Rgba;
  spacing: number;
}

export interface CanvasDoc {
  fileName: string;
  manifestSha256: string;
  format: "xcanvas" | "xnote";
  version: number;
  dpi: number;
  background: Background;
  /** Pages of an .xnote, stacked vertically; null for an infinite canvas. */
  pages: PageInfo[] | null;
  items: CanvasItem[];
  /** Asset name -> object URL (images only). */
  assets: Map<string, string>;
  bounds: Bounds;
  warnings: string[];
}

const TOOLS = new Set(["pen", "dashed", "calligraphy", "speed", "taper", "highlighter"]);
// XNotes InkPalette.LEGACY, used when a stroke has no rgba.
const LEGACY_INK: Rgba = [0, 230, 118, 255];

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const rgba = (v: unknown): Rgba | null =>
  Array.isArray(v) && v.length >= 3 ? [num(v[0], 0), num(v[1], 0), num(v[2], 0), num(v[3], 255)] : null;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // WebCrypto needs a secure context; a lesson file opened from disk may not have one.
  if (!globalThis.crypto?.subtle) return "cyrb53-" + cyrb53(new TextDecoder().decode(bytes)).toString(16);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function grow(b: Bounds, x: number, y: number, r = 0) {
  if (x - r < b.minX) b.minX = x - r;
  if (y - r < b.minY) b.minY = y - r;
  if (x + r > b.maxX) b.maxX = x + r;
  if (y + r > b.maxY) b.maxY = y + r;
}

function unionInto(b: Bounds, o: Bounds) {
  if (!Number.isFinite(o.minX)) return;
  grow(b, o.minX, o.minY);
  grow(b, o.maxX, o.maxY);
}

function parseStroke(raw: Record<string, unknown>, index: number, dx = 0, dy = 0): StrokeItem {
  const toolId = typeof raw.tool === "string" && TOOLS.has(raw.tool) ? raw.tool : "pen";
  const c = (raw.config ?? {}) as Record<string, unknown>;
  const samples = Array.isArray(raw.samples) ? (raw.samples as unknown[]).filter(Array.isArray) as number[][] : [];
  const n = samples.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const p = new Float64Array(n);
  const tArr = new Float64Array(n);
  const wArr = new Float64Array(n);
  let timed = false;
  let widths = n > 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    x[i] = num(s[0], 0) + dx;
    y[i] = num(s[1], 0) + dy;
    p[i] = num(s[2], 1);
    tArr[i] = num(s[3], 0);
    wArr[i] = num(s[4], 0);
    if (tArr[i] !== 0) timed = true;
    if (wArr[i] <= 0) widths = false;
  }
  const straight = bool(raw.straight, false);
  const params: BuildParams = {
    x, y, p,
    t: timed ? tArr : null,
    widthFactor: widths ? wArr : null,
    baseWidth: num(c.base_width, 3.0),
    pressureEnabled: bool(c.pressure_enabled, true),
    m: num(c.pressure_min_factor, 0.35),
    ds: num(c.direction_strength, 0.0),
    speedStrength: num(c.speed_strength, 0.0),
    taperEnabled: bool(c.taper_enabled, false),
    taperMinFactor: num(c.taper_min_factor, 0.0),
    speedScale: num(raw.speed_scale, 1.0),
    smooth: !straight,
    holdEnds: toolId === "pen" || toolId === "highlighter",
    smoothScale: num(raw.smooth_scale, 1.0),
    speedTop: num(c.speed_top, SPEED_HI),
    speedSmoothing: num(c.speed_smoothing, DEFAULT_SPEED_SMOOTHING),
  };
  if (params.speedStrength > 0 && params.widthFactor === null && params.t !== null) {
    params.widthFactor = speedWidths(params);
  }
  const ribbon = buildRibbon(params);
  const color = rgba(c.rgba) ?? LEGACY_INK;
  const highlighter = toolId === "highlighter";
  const approx: string[] = [];
  if (bool(c.neon, false) && !highlighter) approx.push("neon glow");
  if (Array.isArray(raw.cuts) && raw.cuts.length > 0) approx.push("cuts");

  const bounds = emptyBounds();
  const dashedW = params.baseWidth;
  for (let i = 0; i < ribbon.halfWidths.length; i++) {
    const r = toolId === "dashed" ? Math.max(dashedW / 2, ribbon.halfWidths[i]) : ribbon.halfWidths[i];
    grow(bounds, ribbon.centers[2 * i], ribbon.centers[2 * i + 1], r);
  }
  return {
    kind: "stroke",
    index,
    raw,
    bounds,
    tool: toolId,
    color: [color[0], color[1], color[2], 255],
    alpha: (color[3] / 255) * (highlighter ? num(c.highlighter_alpha, 0.35) : 1.0),
    blend: highlighter ? (bool(c.highlighter_inverse, false) ? "screen" : "multiply") : "source-over",
    dashed: toolId === "dashed" ? { width: dashedW, on: num(c.dash_length, 10), gap: num(c.dash_gap, 8) } : null,
    ribbon,
    approx,
  };
}

function rawGeometryBounds(raw: Record<string, unknown>, dx: number, dy: number): Bounds {
  const b = emptyBounds();
  const pt = (v: unknown, r = 0) => {
    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") grow(b, v[0] + dx, v[1] + dy, r);
  };
  const rect = raw.rect;
  if (Array.isArray(rect) && rect.length >= 4) {
    const [rx, ry, rw, rh] = rect.map((v) => num(v, 0));
    grow(b, rx + dx, ry + dy);
    grow(b, rx + rw + dx, ry + rh + dy);
  }
  pt(raw.start);
  pt(raw.end);
  const pad = num(raw.width, 0) / 2 + num(raw.stroke_width, 0) / 2;
  if (Array.isArray(raw.points)) for (const q of raw.points) pt(q, pad);
  if (Number.isFinite(b.minX) && pad > 0) {
    b.minX -= pad; b.minY -= pad; b.maxX += pad; b.maxY += pad;
  }
  return b;
}

function mimeFor(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

// XNotes FontFace ids mapped to the closest web font stacks; text is approximate either way.
const FONTS: Record<string, string> = {
  mono: "ui-monospace, Menlo, Consolas, monospace",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};

let measureCtx: OffscreenCanvasRenderingContext2D | null | undefined;
function measure(text: string, font: string, size: number): number {
  if (measureCtx === undefined) measureCtx = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1).getContext("2d") : null;
  if (!measureCtx) return text.length * size * 0.6;
  measureCtx.font = `${size}px ${font}`;
  return measureCtx.measureText(text).width;
}

function wrap(text: string, width: number, font: string, size: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const tryLine = line + word;
      if (line && measure(tryLine, font, size) > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = tryLine;
      }
    }
    out.push(line);
  }
  return out;
}

/** Text items exist only in .xnote. 13 pt default, at XNotes' fixed 150/72 px per point. */
function parseText(raw: Record<string, unknown>, index: number, dx: number, dy: number): TextItem {
  const pos = Array.isArray(raw.pos) ? raw.pos : [];
  const x = num(pos[0], 0) + dx;
  const y = num(pos[1], 0) + dy;
  const width = num(raw.width, 300);
  const fontSize = num(raw.point_size, 13) * (150 / 72);
  const face = typeof raw.font_face === "string" && raw.font_face ? raw.font_face : "mono";
  const font = FONTS[face] ?? FONTS.sans;
  const text = typeof raw.text === "string" ? raw.text : "";
  const lines = wrap(text, width, font, fontSize);
  const lineHeight = fontSize * 1.25;
  const height = Math.max(num(raw.height, 0), lines.length * lineHeight);
  return {
    kind: "text", index, raw, x, y, width, fontSize, font, text, lines, lineHeight,
    color: rgba(raw.rgba) ?? [236, 236, 236, 255],
    bounds: { minX: x, minY: y, maxX: x + width, maxY: y + height },
  };
}

interface ParseCtx {
  assets: Map<string, string>;
  items: CanvasItem[];
  note: (what: string) => void;
}

function parseItems(rawItems: unknown, ctx: ParseCtx, dx: number, dy: number, page: number | undefined) {
  if (!Array.isArray(rawItems)) return;
  for (const raw of rawItems as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    const index = ctx.items.length;
    const kind = typeof raw.kind === "string" ? raw.kind : "?";
    let item: CanvasItem | null = null;
    if (kind === "stroke") {
      const s = parseStroke(raw, index, dx, dy);
      s.approx.forEach(ctx.note);
      item = s;
    } else if (kind === "text" && page !== undefined) {
      ctx.note("text box (font and wrapping approximate)");
      item = parseText(raw, index, dx, dy);
    } else if (kind === "image" && typeof raw.asset === "string" && ctx.assets.has(raw.asset) && Array.isArray(raw.rect)) {
      const r = (raw.rect as unknown[]).slice(0, 4).map((v) => num(v, 0));
      const approx: string[] = [];
      if (num(raw.angle, 0) !== 0) approx.push("image rotation");
      if (num(raw.orientation, 0) !== 0) approx.push("image orientation");
      if (raw.flip && raw.flip !== "none") approx.push("image flip");
      if (raw.part) approx.push("image crop");
      approx.forEach(ctx.note);
      item = { kind: "image", index, raw, asset: raw.asset, rect: [r[0] + dx, r[1] + dy, r[2], r[3]], bounds: rawGeometryBounds(raw, dx, dy), approx };
    } else {
      const bounds = rawGeometryBounds(raw, dx, dy);
      if (Number.isFinite(bounds.minX)) {
        ctx.note(`${kind} (drawn as placeholder box)`);
        item = { kind: "other", index, raw, rawKind: kind, bounds };
      } else {
        ctx.note(`${kind} (no geometry, skipped)`);
      }
    }
    if (item) {
      if (page !== undefined) item.page = page;
      ctx.items.push(item);
    }
  }
}

const PATTERNS = ["none", "lines", "dots", "grid"];

// A4 portrait at 150 dpi, XNotes' default page.
const A4_150 = { w: (210 / 25.4) * 150, h: (297 / 25.4) * 150 };
// XNotes' default gap between stacked pages (CanvasState side margin), content px.
const PAGE_GAP = 48;

/** Experimental: built from the XNotes DocumentCodec source, not yet tested on a real .xnote file. */
function layoutPages(manifest: Record<string, unknown>, ctx: ParseCtx, warnings: string[]): PageInfo[] {
  const docStyle = (manifest.style ?? {}) as Record<string, unknown>;
  const rawPages = Array.isArray(manifest.pages) ? (manifest.pages as Record<string, unknown>[]) : [];
  const sizes: { w: number; h: number }[] = [];
  for (const pg of rawPages) {
    const prev = sizes.at(-1) ?? A4_150;
    const w = num(pg?.width, prev.w);
    const h = num(pg?.height, prev.h);
    sizes.push({ w: w > 0 ? w : prev.w, h: h > 0 ? h : prev.h });
  }
  const maxW = Math.max(0, ...sizes.map((s) => s.w));
  const pages: PageInfo[] = [];
  let y = 0;
  let pdfPages = 0;
  let templates = 0;
  rawPages.forEach((pg, i) => {
    const { w, h } = sizes[i];
    const x = (maxW - w) / 2;
    const style = (pg?.style ?? {}) as Record<string, unknown>;
    const pick = (k: string) => style[k] ?? docStyle[k];
    const pattern = PATTERNS.includes(pick("pattern") as string) ? (pick("pattern") as Background["pattern"]) : "none";
    if (pg?.pdf_page !== undefined && pg?.pdf_page !== null) pdfPages++;
    if (pick("template")) templates++;
    pages.push({
      bounds: { minX: x, minY: y, maxX: x + w, maxY: y + h },
      color: rgba(pick("page_color")),
      pattern,
      patternColor: rgba(pick("pattern_color")) ?? [150, 150, 150, 128],
      spacing: num(pick("spacing"), 64),
    });
    parseItems(pg?.items, ctx, x, y, i);
    y += h + PAGE_GAP;
  });
  if (pdfPages) warnings.push(`${pdfPages} page(s) have a PDF background, which is not shown.`);
  if (templates) warnings.push(`${templates} page(s) use a custom template, shown as plain paper.`);
  warnings.push("Notebook (.xnote) support is experimental. Please compare with XNotes.");
  return pages;
}

export async function loadDocument(fileName: string, bytes: Uint8Array): Promise<CanvasDoc> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error(`${fileName} is not an XNotes file.`);
  }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error(`${fileName} has no manifest.json.`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
  const format = manifest.format;
  if (format !== "xcanvas" && format !== "xnote") throw new Error(`Unsupported format "${String(format)}".`);
  const warnings: string[] = [];
  const version = num(manifest.version, 0);
  if (version !== 1) warnings.push(`Format version ${version} was not tested (expected 1).`);

  const bg = (manifest.background ?? {}) as Record<string, unknown>;
  const pattern = PATTERNS.includes(bg.pattern as string) ? (bg.pattern as Background["pattern"]) : "grid";
  const background: Background = {
    pattern,
    patternColor: rgba(bg.pattern_color) ?? [150, 150, 150, 64],
    spacing: Math.min(200, Math.max(16, num(bg.spacing, 64))),
    paperColor: rgba(bg.paper_color),
  };

  const assets = new Map<string, string>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith("assets/image-")) {
      assets.set(name, URL.createObjectURL(new Blob([data as BlobPart], { type: mimeFor(name) })));
    }
  }

  const approxCounts = new Map<string, number>();
  const ctx: ParseCtx = { assets, items: [], note: (k) => approxCounts.set(k, (approxCounts.get(k) ?? 0) + 1) };
  let pages: PageInfo[] | null = null;
  if (format === "xnote") pages = layoutPages(manifest, ctx, warnings);
  else parseItems(manifest.items, ctx, 0, 0, undefined);
  for (const [k, n] of approxCounts) warnings.push(`${n} × ${k} not rendered exactly.`);

  const bounds = emptyBounds();
  for (const it of ctx.items) unionInto(bounds, it.bounds);
  for (const pg of pages ?? []) unionInto(bounds, pg.bounds);
  if (!Number.isFinite(bounds.minX)) Object.assign(bounds, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });

  return {
    fileName,
    manifestSha256: await sha256Hex(manifestBytes),
    format,
    version,
    dpi: num(manifest.dpi, 150),
    background,
    pages,
    items: ctx.items,
    assets,
    bounds,
    warnings,
  };
}

/** Kept for callers that only deal with canvases. */
export const loadXCanvas = loadDocument;

export const isNoteFile = (name: string) => /\.(xcanvas|xnote)$/i.test(name);
