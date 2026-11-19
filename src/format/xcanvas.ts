import { unzipSync } from "fflate";
import { DEFAULT_SPEED_SMOOTHING, SPEED_HI, buildRibbon, speedWidths, type BuildParams, type RibbonGeometry } from "../engine/strokeEngine";
import { cyrb53 } from "../lesson/ids";
import { buildShape, labelCorners, shapePolylines, type LabelDraw } from "../shapes/item";
import { tapeBody, tapeOutline, tapePattern, tapePrintColor, TAPE_DEFAULT_WIDTH, type TapeMode, type TapePattern } from "../shapes/tape";
import type { Pt, ShapePath } from "../shapes/types";
import { fontFor, ptToPx, wrap } from "./text";

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
  /** Neon glow (Stroke.paintNeon): strength 0..1 and the two bloom radii; null for plain ink (never on the highlighter). */
  neon: { strength: number; wide: number; tight: number } | null;
  /** Room-cut edges [x, y, nx, ny]: ink past an edge (along its normal) is hidden. */
  cuts: [number, number, number, number][];
}

export interface ImageItem extends ItemBase {
  kind: "image";
  asset: string;
  /** The unturned frame [x, y, w, h]. */
  rect: [number, number, number, number];
  /** Radians about the frame centre. */
  angle: number;
  /** Quarter turns of the picture inside the frame, degrees (0/90/180/270). */
  orientation: number;
  flip: { x: boolean; y: boolean };
  /** Crop: the shown part as fractions [x, y, w, h] of the picture, or null for all of it. */
  part: [number, number, number, number] | null;
  corners: Pt[];
}

export interface TapeItem extends ItemBase {
  kind: "tape";
  /** Convex body pieces; their union is the tape. */
  body: Pt[][];
  /** Printed pattern polygons. */
  marks: Pt[][];
  /** What shows once peeled: the dashed edge. */
  outline: { pts: Pt[]; closed: boolean }[];
  color: Rgba;
  printColor: Rgba;
}

export interface OtherItem extends ItemBase {
  kind: "other";
  rawKind: string;
}

/** Shapes, connectors, drawn text (glyphs) and colour fills: XNotes' role-tagged paths. */
export interface ShapeItem extends ItemBase {
  kind: "shape";
  shapeKind: string;
  /** Page space. */
  paths: ShapePath[];
  stroke: Rgba;
  width: number;
  fill: Rgba | null;
  dash: [number, number] | null;
  /** Neon glow strength 0..1, or null. */
  neon: number | null;
  label: LabelDraw | null;
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

export type CanvasItem = StrokeItem | ImageItem | TextItem | ShapeItem | TapeItem | OtherItem;

/** One page of an .xnote, placed in document coordinates. */
export interface PageInfo {
  bounds: Bounds;
  /** null = theme paper. */
  color: Rgba | null;
  pattern: Background["pattern"];
  patternColor: Rgba;
  spacing: number;
  /** Page of the note's PDF drawn as this page's backdrop (0-based), or null. */
  pdfPage: number | null;
  /** Quarter turns clockwise applied to the PDF page. */
  pdfTurn: number;
}

/** Draws a note's PDF pages; set once the PDF is loaded (in the app) or from pictures (in an export). */
export interface PdfBackdrop {
  /** The page as a picture at least [pxWide] px wide, turned [turn] quarter turns, or null while it renders (call [onReady] then). */
  page(index: number, turn: number, pxWide: number, onReady: () => void): CanvasImageSource | null;
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
  /** The note's source PDF bytes (an .xnote with PDF pages), for the app to render. */
  pdfBytes: Uint8Array | null;
  pdf: PdfBackdrop | null;
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
  const cuts: [number, number, number, number][] = Array.isArray(raw.cuts)
    ? (raw.cuts as unknown[]).filter((c): c is number[] => Array.isArray(c) && c.length >= 4).map((c) => [num(c[0], 0) + dx, num(c[1], 0) + dy, num(c[2], 0), num(c[3], 0)])
    : [];

  let bounds = emptyBounds();
  const dashedW = params.baseWidth;
  for (let i = 0; i < ribbon.halfWidths.length; i++) {
    const r = toolId === "dashed" ? Math.max(dashedW / 2, ribbon.halfWidths[i]) : ribbon.halfWidths[i];
    grow(bounds, ribbon.centers[2 * i], ribbon.centers[2 * i + 1], r);
  }
  if (cuts.length && Number.isFinite(bounds.minX)) bounds = cutBounds(bounds, cuts);
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
    neon: bool(c.neon, false) && !highlighter ? neonOf(num(c.neon_strength, 0.6), params.baseWidth) : null,
    cuts,
  };
}

function neonOf(strength: number, baseWidth: number) {
  const s = Math.min(1, Math.max(0, strength));
  return { strength: s, wide: Math.max(baseWidth * (1.8 + 5.0 * s), 6.0), tight: Math.max(baseWidth * (0.7 + 1.8 * s), 2.5) };
}

/** [poly] cut down by each edge (XNotes CutEdges.clip): what lies past an edge's normal goes. */
export function clipByCuts(poly: Pt[], cuts: [number, number, number, number][]): Pt[] {
  let out = poly;
  for (const [x, y, nx, ny] of cuts) {
    if (!out.length) break;
    const next: Pt[] = [];
    const past = (p: Pt) => (p.x - x) * nx + (p.y - y) * ny;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const da = past(a);
      const db = past(b);
      if (da <= 0) next.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    out = next;
  }
  return out;
}

const boxPoly = (b: Bounds): Pt[] => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];

function cutBounds(b: Bounds, cuts: [number, number, number, number][]): Bounds {
  const poly = clipByCuts(boxPoly(b), cuts);
  if (poly.length < 3) return b;
  const out = emptyBounds();
  for (const p of poly) grow(out, p.x, p.y);
  return out;
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

export function mimeFor(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/** Text items exist only in .xnote. 13 pt default, at XNotes' fixed 150/72 px per point. */
function parseText(raw: Record<string, unknown>, index: number, dx: number, dy: number): TextItem {
  const pos = Array.isArray(raw.pos) ? raw.pos : [];
  const x = num(pos[0], 0) + dx;
  const y = num(pos[1], 0) + dy;
  const width = num(raw.width, 300);
  const fontSize = ptToPx(num(raw.point_size, 13));
  const font = fontFor(raw.font_face);
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

function boundsOf(points: Iterable<Pt>, pad = 0): Bounds {
  const b = emptyBounds();
  for (const p of points) grow(b, p.x, p.y, pad);
  return b;
}

/** XNotes shapes, connectors, drawn text and fills (see shapes/item.ts). */
function parseShape(raw: Record<string, unknown>, index: number, dx: number, dy: number): ShapeItem | null {
  const d = buildShape(raw, dx, dy);
  if (!d) return null;
  const width = num(raw.stroke_width, 2);
  const neon = raw.neon === true ? Math.min(1, Math.max(0, num(raw.neon_strength, 0.6))) : null;
  const pts = shapePolylines(d.paths).flatMap((l) => l.pts);
  if (d.label) pts.push(...labelCorners(d.label));
  const b = boundsOf(pts, width / 2);
  if (!Number.isFinite(b.minX)) return null;
  return {
    kind: "shape", index, raw, bounds: b,
    shapeKind: d.kindId,
    paths: d.paths,
    stroke: rgba(raw.stroke_rgba) ?? [0, 0, 0, 255],
    width,
    fill: rgba(raw.fill_rgba),
    dash: raw.dashed === true ? [num(raw.dash_length, 10), num(raw.dash_gap, 8)] : null,
    neon,
    label: d.label,
  };
}

/** A picture in its frame, turned [angle] about the centre (XNotes ImageItem). */
function parseImage(raw: Record<string, unknown>, index: number, dx: number, dy: number): ImageItem {
  const r = (raw.rect as unknown[]).slice(0, 4).map((v) => num(v, 0));
  const rect: [number, number, number, number] = [r[0] + dx, r[1] + dy, r[2], r[3]];
  const angle = num(raw.angle, 0);
  const cx = rect[0] + rect[2] / 2, cy = rect[1] + rect[3] / 2;
  const cs = Math.cos(angle), sn = Math.sin(angle);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * rect[2]) / 2, y = (sy * rect[3]) / 2;
    return { x: cx + x * cs - y * sn, y: cy + x * sn + y * cs };
  });
  const p = Array.isArray(raw.part) && raw.part.length >= 4 ? (raw.part as unknown[]).map((v) => num(v, 0)) : null;
  const part: ImageItem["part"] = p && p[2] > 0 && p[3] > 0 ? [p[0], p[1], p[2], p[3]] : null;
  const f = typeof raw.flip === "string" ? raw.flip : "";
  return {
    kind: "image", index, raw, asset: raw.asset as string, rect, angle,
    orientation: ((Math.round(num(raw.orientation, 0) / 90) * 90) % 360 + 360) % 360,
    flip: { x: f.includes("x"), y: f.includes("y") },
    part, corners,
    bounds: boundsOf(corners),
  };
}

const TAPE_MODES = new Set<TapeMode>(["straight", "rectangle", "freehand"]);
const TAPE_PATTERNS = new Set<TapePattern>(["solid", "stripes", "dots", "grid"]);

/** Masking tape: an opaque strip over the ink, peeled in the presenter to show what it hides. */
function parseTape(raw: Record<string, unknown>, index: number, dx: number, dy: number): TapeItem | null {
  const points = Array.isArray(raw.points)
    ? (raw.points as unknown[]).filter((v): v is number[] => Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number").map((v) => ({ x: v[0] + dx, y: v[1] + dy }))
    : [];
  if (!points.length) return null;
  const mode = TAPE_MODES.has(raw.mode as TapeMode) ? (raw.mode as TapeMode) : "straight";
  const pattern = TAPE_PATTERNS.has(raw.pattern as TapePattern) ? (raw.pattern as TapePattern) : "solid";
  const shape = { mode, points, width: Math.max(1, num(raw.width, TAPE_DEFAULT_WIDTH)) };
  const c = rgba(raw.rgba) ?? [255, 214, 102, 255];
  const body = tapeBody(shape);
  const print = tapePrintColor([c[0], c[1], c[2]]);
  return {
    kind: "tape", index, raw,
    body,
    marks: tapePattern(shape, pattern),
    outline: tapeOutline(shape),
    color: [c[0], c[1], c[2], 255],
    printColor: [print[0], print[1], print[2], 255],
    bounds: boundsOf(body.flat()),
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
      item = parseStroke(raw, index, dx, dy);
    } else if (kind === "text" && page !== undefined) {
      item = parseText(raw, index, dx, dy);
    } else if (kind === "shape" || kind === "glyphs" || kind === "fill") {
      item = parseShape(raw, index, dx, dy);
    } else if (kind === "image" && typeof raw.asset === "string" && ctx.assets.has(raw.asset) && Array.isArray(raw.rect)) {
      item = parseImage(raw, index, dx, dy);
    } else if (kind === "tape") {
      item = parseTape(raw, index, dx, dy);
    }
    if (!item) {
      const bounds = rawGeometryBounds(raw, dx, dy);
      if (Number.isFinite(bounds.minX)) {
        ctx.note(kind === "audio" ? "audio clip (shown as a box; audio does not play)" : `${kind} (drawn as placeholder box)`);
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

/** Reader for .xnote notebooks, built from the XNotes DocumentCodec source. */
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
  let templates = 0;
  rawPages.forEach((pg, i) => {
    const { w, h } = sizes[i];
    const x = (maxW - w) / 2;
    const style = (pg?.style ?? {}) as Record<string, unknown>;
    const pick = (k: string) => style[k] ?? docStyle[k];
    const pattern = PATTERNS.includes(pick("pattern") as string) ? (pick("pattern") as Background["pattern"]) : "none";
    if (pick("template")) templates++;
    const pdfPage = typeof pg?.pdf_page === "number" && pg.pdf_page >= 0 ? Math.floor(pg.pdf_page) : null;
    pages.push({
      bounds: { minX: x, minY: y, maxX: x + w, maxY: y + h },
      color: rgba(pick("page_color")),
      pattern,
      patternColor: rgba(pick("pattern_color")) ?? [150, 150, 150, 128],
      spacing: num(pick("spacing"), 64),
      pdfPage,
      pdfTurn: pdfPage === null ? 0 : ((Math.round(num(pg?.pdf_turn, 0)) % 4) + 4) % 4,
    });
    parseItems(pg?.items, ctx, x, y, i);
    y += h + PAGE_GAP;
  });
  if (templates) warnings.push(`${templates} page(s) use a custom template, shown as plain paper.`);
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
    pdfBytes: pages?.some((p) => p.pdfPage !== null) ? (entries["assets/source.pdf"] ?? null) : null,
    pdf: null,
    bounds,
    warnings,
  };
}

/** Kept for callers that only deal with canvases. */
export const loadXCanvas = loadDocument;

export const isNoteFile = (name: string) => /\.(xcanvas|xnote)$/i.test(name);
