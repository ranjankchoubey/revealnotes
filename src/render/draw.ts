import type { Background, Bounds, CanvasDoc, CanvasItem, PageInfo, Rgba, StrokeItem } from "../format/xcanvas";

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
function partialRibbonPath(s: StrokeItem, t: number): Path2D {
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
  return buildRibbon(centers, halves, m);
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

function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeItem, written = 1) {
  const color = s.color;
  ctx.save();
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
  } else {
    ctx.fillStyle = css(color, 1);
    ctx.fill(written >= 1 ? ribbonPath(s) : partialRibbonPath(s, written), "nonzero");
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

function drawRevealing(ctx: CanvasRenderingContext2D, doc: CanvasDoc, it: CanvasItem, onAsset: () => void, r?: RevealState) {
  if (!r || r.p >= 1 || r.style === "instant") return drawItem(ctx, doc, it, onAsset);
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
      drawItem(ctx, doc, it, onAsset);
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
      drawItem(ctx, doc, it, onAsset);
      break;
    }
    case "rise": {
      const e = easeOut(p);
      ctx.globalAlpha *= e;
      ctx.translate(0, (1 - e) * Math.min(60, (b.maxY - b.minY) * 0.6 + 20));
      drawItem(ctx, doc, it, onAsset);
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
      drawItem(ctx, doc, it, onAsset);
      break;
    }
    default:
      ctx.globalAlpha *= easeOut(p);
      drawItem(ctx, doc, it, onAsset);
  }
  ctx.restore();
}

const imageCache = new Map<string, HTMLImageElement>();

function drawItem(ctx: CanvasRenderingContext2D, doc: CanvasDoc, it: CanvasItem, onAsset: () => void) {
  if (it.kind === "stroke") return drawStroke(ctx, it);
  if (it.kind === "shape") {
    ctx.save();
    ctx.beginPath();
    if (it.ellipse) {
      const e = it.ellipse;
      ctx.ellipse((e.minX + e.maxX) / 2, (e.minY + e.maxY) / 2, (e.maxX - e.minX) / 2, (e.maxY - e.minY) / 2, 0, 0, Math.PI * 2);
    } else if (it.points) {
      it.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (it.closed) ctx.closePath();
    }
    if (it.fill && it.closed) {
      ctx.fillStyle = css(it.fill);
      ctx.fill();
    }
    if (it.stroke && it.width > 0) {
      ctx.strokeStyle = css(it.stroke);
      ctx.lineWidth = it.width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (it.dash) ctx.setLineDash(it.dash);
      ctx.stroke();
      if (it.arrow && it.points && it.points.length >= 2) {
        const [x0, y0] = it.points[it.points.length - 2];
        const [x1, y1] = it.points[it.points.length - 1];
        const a = Math.atan2(y1 - y0, x1 - x0);
        const len = Math.max(12, it.width * 5);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1 - len * Math.cos(a - 0.45), y1 - len * Math.sin(a - 0.45));
        ctx.lineTo(x1, y1);
        ctx.lineTo(x1 - len * Math.cos(a + 0.45), y1 - len * Math.sin(a + 0.45));
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }
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
    const url = doc.assets.get(it.asset);
    if (!url) return;
    let img = imageCache.get(url);
    if (!img) {
      img = new Image();
      img.onload = onAsset;
      img.src = url;
      imageCache.set(url, img);
    }
    if (img.complete && img.naturalWidth > 0) ctx.drawImage(img, it.rect[0], it.rect[1], it.rect[2], it.rect[3]);
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

/** .xnote pages: a backdrop, then each page's paper and ruling (lines anchored at the page origin). */
function drawPages(ctx: CanvasRenderingContext2D, pages: PageInfo[], view: View, w: number, h: number, paper: Rgba) {
  const dark = paper[0] + paper[1] + paper[2] < 384;
  ctx.fillStyle = dark ? "#0b0b0e" : "#d9dade";
  ctx.fillRect(0, 0, w, h);
  const sx = (x: number) => (x - view.scrollX) * view.zoom;
  const sy = (y: number) => (y - view.scrollY) * view.zoom;
  for (const pg of pages) {
    const b = pg.bounds;
    const x0 = sx(b.minX), y0 = sy(b.minY), x1 = sx(b.maxX), y1 = sy(b.maxY);
    if (x1 < 0 || y1 < 0 || x0 > w || y0 > h) continue;
    ctx.fillStyle = css(pg.color ?? paper, 1);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
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
  accent?: Rgba;
  /** Drawn last, in content coordinates (the presenter's laser). */
  overlay?: (ctx: CanvasRenderingContext2D, view: View) => void;
  /** Items mid-animation in the presenter. */
  reveal?: (it: CanvasItem) => RevealState | undefined;
  /** Numbered markers (step numbers in the editor), drawn at constant screen size. */
  badges?: { x: number; y: number; label: string; color: Rgba }[];
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
  if (o.doc.pages) drawPages(ctx, o.doc.pages, view, o.width, o.height, PAPER[o.paper]);
  else drawBackground(ctx, o.doc.background, view, o.width, o.height, PAPER[o.paper]);
  const vx0 = view.scrollX, vy0 = view.scrollY;
  const vx1 = vx0 + o.width / view.zoom, vy1 = vy0 + o.height / view.zoom;
  const onAsset = o.onAsset ?? (() => {});

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
  for (const it of o.doc.items) if (onScreen(it)) drawRevealing(ctx, o.doc, it, onAsset, o.reveal?.(it));
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
