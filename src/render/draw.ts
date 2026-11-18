import { clipByCuts, type Background, type Bounds, type CanvasDoc, type CanvasItem, type ImageItem, type PageInfo, type Rgba, type ShapeItem, type StrokeItem, type TapeItem } from "../format/xcanvas";
import type { Contour, PathRole, ShapePath } from "../shapes/types";
import { TAPE_DASH, TAPE_OUTLINE_WIDTH } from "../shapes/tape";

export interface View {
  /** Content coordinate at the canvas's top-left. */
  scrollX: number;
  scrollY: number;
  /** CSS px per content px. */
  zoom: number;
}

export type PaperMode = "dark" | "light";

// XNotes resolves the paper from the device's Material theme (not stored in the file).
// These approximate its default dark paper and light paper.
export const PAPER: Record<PaperMode, Rgba> = {
  dark: [26, 27, 33, 255],
  light: [255, 255, 255, 255],
};

const css = (c: Rgba, alpha = c[3] / 255) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;

const pathCache = new WeakMap<StrokeItem, Path2D>();

/**
 * Union of a disc at every sample and the tangent hull between neighbouring discs, all wound the
 * same way so one non-zero fill paints the union with no seams (XNotes Renderer.fillDiskRibbon).
 */
export function ribbonPath(s: StrokeItem): Path2D {
  const cached = pathCache.get(s);
  if (cached) return cached;
  const path = buildRibbon(s.ribbon.centers, s.ribbon.halfWidths, s.ribbon.halfWidths.length);
  pathCache.set(s, path);
  return path;
}

const arcCache = new WeakMap<StrokeItem, Float64Array>();

/** Cumulative length along a stroke's centreline. */
export function strokeArc(s: StrokeItem): Float64Array {
  let a = arcCache.get(s);
  if (a) return a;
  const c = s.ribbon.centers;
  const n = s.ribbon.halfWidths.length;
  a = new Float64Array(Math.max(1, n));
  for (let i = 1; i < n; i++) a[i] = a[i - 1] + Math.hypot(c[2 * i] - c[2 * i - 2], c[2 * i + 1] - c[2 * i - 1]);
  arcCache.set(s, a);
  return a;
}

/** The ribbon written up to fraction [t] of its length: the pen replaying the stroke. */
function partialRibbon(s: StrokeItem, t: number): { centers: Float64Array; halves: Float64Array; n: number } {
  const arc = strokeArc(s);
  const n = s.ribbon.halfWidths.length;
  const target = arc[n - 1] * t;
  let k = 0;
  while (k < n - 1 && arc[k + 1] <= target) k++;
  const c = s.ribbon.centers;
  const h = s.ribbon.halfWidths;
  const centers = new Float64Array(2 * (k + 2));
  const halves = new Float64Array(k + 2);
  centers.set(c.subarray(0, 2 * (k + 1)));
  halves.set(h.subarray(0, k + 1));
  let m = k + 1;
  if (k < n - 1) {
    const span = arc[k + 1] - arc[k];
    const f = span > 0 ? (target - arc[k]) / span : 0;
    centers[2 * m] = c[2 * k] + (c[2 * k + 2] - c[2 * k]) * f;
    centers[2 * m + 1] = c[2 * k + 1] + (c[2 * k + 3] - c[2 * k + 1]) * f;
    halves[m] = h[k] + (h[k + 1] - h[k]) * f;
    m++;
  }
  return { centers, halves, n: m };
}

function buildRibbon(c: ArrayLike<number>, h: ArrayLike<number>, n: number): Path2D {
  const path = new Path2D();
  for (let i = 0; i < n; i++) {
    const x = c[2 * i];
    const y = c[2 * i + 1];
    const r = h[i];
    if (r <= 0) continue;
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, Math.PI * 2, false);
    path.closePath();
  }
  for (let i = 1; i < n; i++) {
    const x1 = c[2 * i - 2], y1 = c[2 * i - 1], r1 = h[i - 1];
    const x2 = c[2 * i], y2 = c[2 * i + 1], r2 = h[i];
    const dx = x2 - x1, dy = y2 - y1;
    const d = Math.hypot(dx, dy);
    if (d <= Math.abs(r1 - r2) || d < 1e-9) continue; // one disc contains the other
    const ux = dx / d, uy = dy / d;
    const a = (r1 - r2) / d;
    const b = Math.sqrt(Math.max(0, 1 - a * a));
    // Outer tangent directions: a*u ± b*perp(u).
    const n1x = a * ux - b * uy, n1y = a * uy + b * ux;
    const n2x = a * ux + b * uy, n2y = a * uy - b * ux;
    const p = [
      x1 + r1 * n1x, y1 + r1 * n1y,
      x2 + r2 * n1x, y2 + r2 * n1y,
      x2 + r2 * n2x, y2 + r2 * n2y,
      x1 + r1 * n2x, y1 + r1 * n2y,
    ];
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      area += p[2 * k] * p[2 * j + 1] - p[2 * j] * p[2 * k + 1];
    }
    // Match the discs' winding (canvas arc with anticlockwise=false has positive shoelace area).
    const order = area >= 0 ? [0, 1, 2, 3] : [3, 2, 1, 0];
    path.moveTo(p[2 * order[0]], p[2 * order[0] + 1]);
    for (let k = 1; k < 4; k++) path.lineTo(p[2 * order[k]], p[2 * order[k] + 1]);
    path.closePath();
  }
  return path;
}

/** Device px per content px under the current transform (shadow blur is not transformed). */
const deviceScale = (ctx: CanvasRenderingContext2D) => {
  const t = ctx.getTransform();
  return Math.hypot(t.a, t.b) || 1;
};

/** A canvas shadow blur matching an Android BlurMaskFilter radius (sigma = 0.57735 r + 0.5). */
const blurFor = (ctx: CanvasRenderingContext2D, radius: number) => 2 * (0.57735 * radius * deviceScale(ctx) + 0.5);

const lighten = (c: Rgba, t: number): Rgba => [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t, c[3]];

const HUGE = 1e5;

function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeItem, written = 1) {
  const color = s.color;
  ctx.save();
  if (s.cuts.length) {
    // Ink cut by a room shows only on the near side of each edge (Stroke.clipRegion).
    const poly = clipByCuts([{ x: -HUGE, y: -HUGE }, { x: HUGE, y: -HUGE }, { x: HUGE, y: HUGE }, { x: -HUGE, y: HUGE }], s.cuts);
    if (poly.length < 3) return ctx.restore();
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
  }
  ctx.globalAlpha *= s.alpha;
  ctx.globalCompositeOperation = s.blend;
  if (s.dashed && s.ribbon.halfWidths.length >= 2) {
    const c = s.ribbon.centers;
    const arc = strokeArc(s);
    const limit = arc[arc.length - 1] * written;
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    for (let i = 2; i < c.length && arc[i / 2] <= limit; i += 2) ctx.lineTo(c[i], c[i + 1]);
    ctx.strokeStyle = css(color, 1);
    ctx.lineWidth = s.dashed.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([s.dashed.on, s.dashed.gap]);
    ctx.stroke();
  } else if (s.neon) {
    const part = written >= 1 ? null : partialRibbon(s, written);
    const path = part ? buildRibbon(part.centers, part.halves, part.n) : ribbonPath(s);
    const n = s.neon;
    // Stroke.paintNeon: a wide faint bloom, a tight bright one, the tube lifted toward white, a white-hot core.
    for (const [radius, alpha] of [[n.wide, 0.42 * n.strength], [n.tight, 0.85 * n.strength]]) {
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.shadowColor = css(color, 1);
      ctx.shadowBlur = blurFor(ctx, radius);
      ctx.fillStyle = css(color, 1);
      ctx.fill(path, "nonzero");
      ctx.restore();
    }
    ctx.fillStyle = css(lighten(color, 0.1), 1);
    ctx.fill(path, "nonzero");
    const src = part ?? { centers: s.ribbon.centers, halves: s.ribbon.halfWidths, n: s.ribbon.halfWidths.length };
    const core = new Float64Array(src.n);
    for (let i = 0; i < src.n; i++) core[i] = src.halves[i] * 0.3;
    ctx.fillStyle = "#fff";
    ctx.fill(buildRibbon(src.centers, core, src.n), "nonzero");
  } else {
    ctx.fillStyle = css(color, 1);
    if (written >= 1) ctx.fill(ribbonPath(s), "nonzero");
    else {
      const p = partialRibbon(s, written);
      ctx.fill(buildRibbon(p.centers, p.halves, p.n), "nonzero");
    }
  }
  ctx.restore();
}

const shapePathCache = new WeakMap<ShapePath, Path2D>();

function contourInto(path: Path2D, c: Contour) {
  path.moveTo(c.start.x, c.start.y);
  for (const s of c.segs) {
    if (s.t === "L") path.lineTo(s.end.x, s.end.y);
    else path.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.end.x, s.end.y);
  }
  if (c.closed) path.closePath();
}

function path2d(p: ShapePath): Path2D {
  let out = shapePathCache.get(p);
  if (!out) {
    out = new Path2D();
    for (const c of p.contours) contourInto(out, c);
    shapePathCache.set(p, out);
  }
  return out;
}

const mix = (c: Rgba, to: number, t: number): Rgba => [
  Math.trunc(c[0] + (to - c[0]) * t), Math.trunc(c[1] + (to - c[1]) * t), Math.trunc(c[2] + (to - c[2]) * t), c[3],
];

/** ShapePainter.fillColor: what a path of [role] fills with; null = unfilled. */
function fillColor(role: PathRole, fill: Rgba | null, outline: Rgba): Rgba | null {
  switch (role) {
    case "OUTLINE":
    case "FILL_ONLY":
      return fill;
    case "SHADE_DARK":
      return fill && mix(fill, 0, 0.25);
    case "SHADE_LIGHT":
      return fill && mix(fill, 255, 0.35);
    case "HEAD_FILLED":
      return outline;
    default:
      return null;
  }
}

/** ShapePainter.strokePen: the dash a path of [role] strokes with ([] = solid); undefined = not stroked. */
function strokeDash(role: PathRole, dash: [number, number] | null, width: number): number[] | undefined {
  switch (role) {
    case "OUTLINE":
    case "STROKE_ONLY":
      return dash ?? [];
    case "HIDDEN":
      return dash ?? [4 + width * 2, 3 + width * 1.5];
    case "HEAD":
    case "HEAD_FILLED":
      return [];
    default:
      return undefined;
  }
}

function strokePaths(ctx: CanvasRenderingContext2D, it: ShapeItem, color: Rgba, width: number) {
  if (width <= 0) return;
  ctx.strokeStyle = css(color);
  ctx.lineWidth = width;
  for (const p of it.paths) {
    const dash = strokeDash(p.role, it.dash, width);
    if (!dash) continue;
    ctx.setLineDash(dash);
    ctx.stroke(path2d(p));
  }
  ctx.setLineDash([]);
}

/** A shape as XNotes paints it: fills by role, the outline (glowing when neon), then the label. */
function drawShape(ctx: CanvasRenderingContext2D, it: ShapeItem) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const p of it.paths) {
    const c = fillColor(p.role, it.fill, it.stroke);
    if (!c) continue;
    ctx.fillStyle = css(c);
    ctx.fill(path2d(p), p.fillRule);
  }
  if (it.neon !== null) {
    const s = it.neon;
    // Outline.paintNeon: a blurred layer, the outline itself, then a thin white core.
    ctx.save();
    ctx.globalAlpha *= 0.25 + 0.55 * s;
    ctx.shadowColor = css(it.stroke, 1);
    ctx.shadowBlur = blurFor(ctx, Math.max(it.width * (1.2 + 2.6 * s), 4));
    strokePaths(ctx, it, [it.stroke[0], it.stroke[1], it.stroke[2], 255], it.width);
    ctx.restore();
    strokePaths(ctx, it, it.stroke, it.width);
    strokePaths(ctx, it, [255, 255, 255, 255], Math.max(it.width * 0.4, 1));
  } else {
    strokePaths(ctx, it, it.stroke, it.width);
  }
  const l = it.label;
  if (l) {
    ctx.translate(l.cx, l.cy);
    if (l.rotation) ctx.rotate(l.rotation);
    ctx.font = `${l.size}px ${l.font}`;
    ctx.fillStyle = css(l.color);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    l.lines.forEach((line, i) => ctx.fillText(line, 0, -l.h / 2 + (i + 0.5) * l.lineHeight));
  }
  ctx.restore();
}

/** AndroidRenderer.drawImage: frame centre, turn, crop to the frame, mirror, quarter-turn the picture. */
function drawImageItem(ctx: CanvasRenderingContext2D, it: ImageItem, img: HTMLImageElement) {
  const [x, y, w, h] = it.rect;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  if (it.angle) ctx.rotate(it.angle);
  if (it.part) {
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();
  }
  if (it.flip.x || it.flip.y) ctx.scale(it.flip.x ? -1 : 1, it.flip.y ? -1 : 1);
  if (it.orientation) ctx.rotate((it.orientation * Math.PI) / 180);
  const swap = it.orientation === 90 || it.orientation === 270;
  const uw = swap ? h : w;
  const uh = swap ? w : h;
  if (it.part) {
    const [px, py, pw, ph] = it.part;
    const W = uw / pw;
    const H = uh / ph;
    const ox = (0.5 - (px + pw / 2)) * W;
    const oy = (0.5 - (py + ph / 2)) * H;
    ctx.drawImage(img, ox - W / 2, oy - H / 2, W, H);
  } else {
    ctx.drawImage(img, -uw / 2, -uh / 2, uw, uh);
  }
  ctx.restore();
}

/** Masking tape: the opaque strip with its printed pattern, or once peeled just its dashed edge. */
function drawTape(ctx: CanvasRenderingContext2D, it: TapeItem, peeled: boolean) {
  ctx.save();
  const polys = (list: { x: number; y: number }[][], closed = true) => {
    ctx.beginPath();
    for (const poly of list) {
      poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (closed) ctx.closePath();
    }
  };
  if (peeled) {
    ctx.strokeStyle = css(it.color, 1);
    ctx.lineWidth = TAPE_OUTLINE_WIDTH;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(TAPE_DASH);
    for (const o of it.outline) {
      polys([o.pts], o.closed);
      ctx.stroke();
    }
  } else {
    // One piece at a time, so overlapping capsules never cancel out under a winding rule.
    ctx.fillStyle = css(it.color, 1);
    for (const piece of it.body) {
      polys([piece]);
      ctx.fill();
    }
    ctx.fillStyle = css(it.printColor, 1);
    for (const m of it.marks) {
      polys([m]);
      ctx.fill();
    }
  }
  ctx.restore();
}

export type RevealStyle = "instant" | "fade" | "write" | "wipe" | "roll" | "rise" | "pop";

/** How far an item is into its reveal animation; omitted = fully shown. */
export interface RevealState {
  style: RevealStyle;
  /** 0..1 */
  p: number;
  /** Wipe: the whole step's bounds, swept left to right. */
  area?: Bounds;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
// Slight overshoot, for "pop".
const easeBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

interface DrawEnv {
  doc: CanvasDoc;
  onAsset: () => void;
  peeled?: (it: TapeItem) => boolean;
}

function drawRevealing(ctx: CanvasRenderingContext2D, env: DrawEnv, it: CanvasItem, r?: RevealState) {
  if (!r || r.p >= 1 || r.style === "instant") return drawItem(ctx, env, it);
  if (r.p <= 0) return;
  const p = r.p;
  const b = it.bounds;
  ctx.save();
  switch (r.style) {
    case "write":
      if (it.kind === "stroke") {
        drawStroke(ctx, it, p);
        break;
      }
      ctx.globalAlpha *= easeOut(p);
      drawItem(ctx, env, it);
      break;
    case "wipe":
    case "roll": {
      // A soft-edged sweep across the whole step: left to right (wipe) or top to bottom (roll).
      const a = r.area ?? b;
      const e = easeOut(p);
      ctx.beginPath();
      if (r.style === "wipe") ctx.rect(a.minX - 50, a.minY - 50, (a.maxX - a.minX + 100) * e, a.maxY - a.minY + 100);
      else ctx.rect(a.minX - 50, a.minY - 50, a.maxX - a.minX + 100, (a.maxY - a.minY + 100) * e);
      ctx.clip();
      drawItem(ctx, env, it);
      break;
    }
    case "rise": {
      const e = easeOut(p);
      ctx.globalAlpha *= e;
      ctx.translate(0, (1 - e) * Math.min(60, (b.maxY - b.minY) * 0.6 + 20));
      drawItem(ctx, env, it);
      break;
    }
    case "pop": {
      const s = 0.6 + 0.4 * easeBack(p);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      ctx.globalAlpha *= Math.min(1, p * 2.5);
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      drawItem(ctx, env, it);
      break;
    }
    default:
      ctx.globalAlpha *= easeOut(p);
      drawItem(ctx, env, it);
  }
  ctx.restore();
}

const imageCache = new Map<string, HTMLImageElement>();

function drawItem(ctx: CanvasRenderingContext2D, env: DrawEnv, it: CanvasItem) {
  if (it.kind === "stroke") return drawStroke(ctx, it);
  if (it.kind === "shape") return drawShape(ctx, it);
  if (it.kind === "tape") return drawTape(ctx, it, env.peeled?.(it) ?? false);
  if (it.kind === "text") {
    ctx.save();
    ctx.font = `${it.fontSize}px ${it.font}`;
    ctx.fillStyle = css(it.color);
    ctx.textBaseline = "top";
    it.lines.forEach((line, i) => ctx.fillText(line, it.x, it.y + i * it.lineHeight));
    ctx.restore();
    return;
  }
  if (it.kind === "image") {
    const url = env.doc.assets.get(it.asset);
    if (!url) return;
    let img = imageCache.get(url);
    if (!img) {
      img = new Image();
      img.onload = env.onAsset;
      img.src = url;
      imageCache.set(url, img);
    }
    if (img.complete && img.naturalWidth > 0) drawImageItem(ctx, it, img);
    return;
  }
  const b = it.bounds;
  ctx.save();
  ctx.strokeStyle = "rgba(160,160,160,0.8)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  ctx.restore();
}

/** Procedural ruling as in XNotes BackgroundPattern: 1 px lines / 1.4 px dots, power-of-two levels. */
function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, view: View, w: number, h: number, paper: Rgba) {
  ctx.fillStyle = css(paper, 1);
  ctx.fillRect(0, 0, w, h);
  if (bg.pattern === "none") return;
  const target = Math.max(bg.spacing, 24);
  let k = 1;
  for (let i = 0; i < 64 && bg.spacing * view.zoom * k < target; i++) k *= 2;
  for (let i = 0; i < 64 && bg.spacing * view.zoom * (k / 2) >= target; i++) k /= 2;
  const period = bg.spacing * k;
  const periodPx = period * view.zoom;
  const subAlpha = Math.min(1, Math.max(0, (periodPx - target) / target));
  const layer = (p: number, alphaScale: number) => {
    if (alphaScale <= 0) return;
    const color = css(bg.patternColor, (bg.patternColor[3] / 255) * alphaScale);
    const x0 = Math.floor(view.scrollX / p) * p;
    const y0 = Math.floor(view.scrollY / p) * p;
    const x1 = view.scrollX + w / view.zoom;
    const y1 = view.scrollY + h / view.zoom;
    const sx = (x: number) => Math.round((x - view.scrollX) * view.zoom) + 0.5;
    const sy = (y: number) => Math.round((y - view.scrollY) * view.zoom) + 0.5;
    if (bg.pattern === "dots") {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let x = x0; x <= x1; x += p) {
        for (let y = y0; y <= y1; y += p) {
          ctx.moveTo(sx(x) + 1.4, sy(y));
          ctx.arc(sx(x), sy(y), 1.4, 0, Math.PI * 2);
        }
      }
      ctx.fill();
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = y0; y <= y1; y += p) {
      ctx.moveTo(0, sy(y));
      ctx.lineTo(w, sy(y));
    }
    if (bg.pattern === "grid") {
      for (let x = x0; x <= x1; x += p) {
        ctx.moveTo(sx(x), 0);
        ctx.lineTo(sx(x), h);
      }
    }
    ctx.stroke();
  };
  layer(period / 2, subAlpha);
  layer(period, 1);
}

/** .xnote pages: a backdrop, then each page's paper (or PDF page) and ruling (lines anchored at the page origin). */
function drawPages(ctx: CanvasRenderingContext2D, doc: CanvasDoc, pages: PageInfo[], view: View, w: number, h: number, paper: Rgba, onAsset: () => void) {
  const dark = paper[0] + paper[1] + paper[2] < 384;
  const dpr = deviceScale(ctx);
  ctx.fillStyle = dark ? "#0b0b0e" : "#d9dade";
  ctx.fillRect(0, 0, w, h);
  const sx = (x: number) => (x - view.scrollX) * view.zoom;
  const sy = (y: number) => (y - view.scrollY) * view.zoom;
  for (const pg of pages) {
    const b = pg.bounds;
    const x0 = sx(b.minX), y0 = sy(b.minY), x1 = sx(b.maxX), y1 = sy(b.maxY);
    if (x1 < 0 || y1 < 0 || x0 > w || y0 > h) continue;
    ctx.fillStyle = css(pg.color ?? (pg.pdfPage !== null ? [255, 255, 255, 255] : paper), 1);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    if (pg.pdfPage !== null && doc.pdf) {
      const img = doc.pdf.page(pg.pdfPage, pg.pdfTurn, (x1 - x0) * dpr, onAsset);
      if (img) ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
      continue;
    }
    if (pg.pattern === "none" || pg.spacing * view.zoom < 4) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    const step = pg.spacing;
    ctx.strokeStyle = ctx.fillStyle = css(pg.patternColor);
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (pg.pattern === "dots") {
      for (let x = b.minX + step; x < b.maxX; x += step) {
        for (let y = b.minY + step; y < b.maxY; y += step) {
          ctx.moveTo(sx(x) + 1.4, sy(y));
          ctx.arc(sx(x), sy(y), 1.4, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else {
      for (let y = b.minY + step; y < b.maxY; y += step) {
        ctx.moveTo(x0, Math.round(sy(y)) + 0.5);
        ctx.lineTo(x1, Math.round(sy(y)) + 0.5);
      }
      if (pg.pattern === "grid") {
        for (let x = b.minX + step; x < b.maxX; x += step) {
          ctx.moveTo(Math.round(sx(x)) + 0.5, y0);
          ctx.lineTo(Math.round(sx(x)) + 0.5, y1);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

export interface RenderOptions {
  doc: CanvasDoc;
  view: View;
  /** CSS size of the canvas. */
  width: number;
  height: number;
  paper: PaperMode;
  /** Return false to hide an item. */
  visible?: (it: CanvasItem) => boolean;
  /** Coloured glow drawn under an item (its step colour); undefined = none. */
  halo?: (it: CanvasItem) => Rgba | undefined;
  /** Item under the pointer, outlined in [accent]. */
  hover?: CanvasItem | null;
  marquee?: Bounds | null;
  /** Freehand lasso loop being drawn, content coordinates. */
  lasso?: [number, number][] | null;
  /** Items to call out (e.g. new since the steps were saved): dashed frame. */
  flagged?: (it: CanvasItem) => boolean;
  /** A selection being previewed: these glow in [accent], everything else is dimmed. */
  selected?: (it: CanvasItem) => boolean;
  accent?: Rgba;
  /** Drawn last, in content coordinates (the presenter's laser). */
  overlay?: (ctx: CanvasRenderingContext2D, view: View) => void;
  /** Items mid-animation in the presenter. */
  reveal?: (it: CanvasItem) => RevealState | undefined;
  /** Numbered markers (step numbers in the editor), drawn at constant screen size. */
  badges?: { x: number; y: number; label: string; color: Rgba }[];
  /** Tapes peeled back (presenter): drawn as their dashed edge, showing what they cover. */
  peeled?: (it: TapeItem) => boolean;
  onAsset?: () => void;
}

function glow(ctx: CanvasRenderingContext2D, it: CanvasItem, width: number) {
  if (it.kind === "stroke") {
    const p = ribbonPath(it);
    ctx.lineWidth = width * 2;
    ctx.stroke(p);
    ctx.fill(p);
  } else {
    const b = it.bounds;
    ctx.fillRect(b.minX - width, b.minY - width, b.maxX - b.minX + 2 * width, b.maxY - b.minY + 2 * width);
  }
}

export function render(ctx: CanvasRenderingContext2D, o: RenderOptions) {
  const dpr = ctx.canvas.width / Math.max(1, o.width);
  const { view } = o;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const onAsset = o.onAsset ?? (() => {});
  if (o.doc.pages) drawPages(ctx, o.doc, o.doc.pages, view, o.width, o.height, PAPER[o.paper], onAsset);
  else drawBackground(ctx, o.doc.background, view, o.width, o.height, PAPER[o.paper]);
  const vx0 = view.scrollX, vy0 = view.scrollY;
  const vx1 = vx0 + o.width / view.zoom, vy1 = vy0 + o.height / view.zoom;
  const env: DrawEnv = { doc: o.doc, onAsset, peeled: o.peeled };

  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, -vx0 * view.zoom * dpr, -vy0 * view.zoom * dpr);
  const onScreen = (it: CanvasItem) => {
    const b = it.bounds;
    return !(b.maxX < vx0 || b.minX > vx1 || b.maxY < vy0 || b.minY > vy1) && (!o.visible || o.visible(it));
  };
  if (o.halo) {
    ctx.save();
    ctx.lineJoin = "round";
    for (const it of o.doc.items) {
      const c = onScreen(it) ? o.halo(it) : undefined;
      if (!c) continue;
      ctx.strokeStyle = ctx.fillStyle = css(c);
      glow(ctx, it, 5 / view.zoom);
    }
    ctx.restore();
  }
  if (o.hover && onScreen(o.hover)) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = css(o.accent ?? [255, 255, 255, 255], 0.9);
    glow(ctx, o.hover, 2.5 / view.zoom);
    ctx.restore();
  }
  if (o.selected) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = css(o.accent ?? [255, 170, 0, 255], 0.85);
    for (const it of o.doc.items) if (onScreen(it) && o.selected(it)) glow(ctx, it, 4 / view.zoom);
    ctx.restore();
  }
  for (const it of o.doc.items) {
    if (!onScreen(it)) continue;
    const dim = o.selected && !o.selected(it);
    if (dim) ctx.globalAlpha = 0.25;
    drawRevealing(ctx, env, it, o.reveal?.(it));
    if (dim) ctx.globalAlpha = 1;
  }
  if (o.flagged) {
    const pad = 6 / view.zoom;
    ctx.save();
    ctx.lineWidth = 2 / view.zoom;
    ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
    ctx.strokeStyle = "rgba(255,140,0,0.95)";
    for (const it of o.doc.items) {
      if (!onScreen(it) || !o.flagged(it)) continue;
      const b = it.bounds;
      ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
    }
    ctx.restore();
  }
  if (o.lasso && o.lasso.length > 1) {
    const a = o.accent ?? [255, 170, 0, 255];
    ctx.save();
    ctx.beginPath();
    o.lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = css(a, 0.1);
    ctx.fill();
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
    ctx.strokeStyle = css(a, 0.95);
    ctx.stroke();
    ctx.restore();
  }
  if (o.marquee) {
    const m = o.marquee;
    const a = o.accent ?? [255, 170, 0, 255];
    ctx.save();
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
    ctx.strokeStyle = css(a, 0.95);
    ctx.fillStyle = css(a, 0.1);
    ctx.fillRect(m.minX, m.minY, m.maxX - m.minX, m.maxY - m.minY);
    ctx.strokeRect(m.minX, m.minY, m.maxX - m.minX, m.maxY - m.minY);
    ctx.restore();
  }
  o.overlay?.(ctx, view);
  if (o.badges?.length) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "600 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const b of o.badges) {
      const x = (b.x - view.scrollX) * view.zoom - 8;
      const y = (b.y - view.scrollY) * view.zoom - 8;
      if (x < -20 || y < -20 || x > o.width + 20 || y > o.height + 20) continue;
      const r = b.label.length > 1 ? 12 : 10;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = css(b.color, 1);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
      ctx.fillStyle = "#1b1b1f";
      ctx.fillText(b.label, x, y + 0.5);
    }
  }
}

/** View that fits [b] into a w×h viewport with a margin, plus extra room for overlaid bars. */
export function fitView(b: Bounds, w: number, h: number, margin = 40, top = 0, bottom = 0): View {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const availH = h - 2 * margin - top - bottom;
  const zoom = Math.max(0.02, Math.min((w - 2 * margin) / bw, availH / bh, 8));
  return {
    zoom,
    scrollX: (b.minX + b.maxX) / 2 - w / (2 * zoom),
    scrollY: (b.minY + b.maxY) / 2 - (top + margin + availH / 2) / zoom,
  };
}
