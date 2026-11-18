import type { View } from "./draw";

export interface LaserStroke {
  pts: [number, number][];
  /** performance.now() when the pen lifted; null while drawing. */
  liftedAt: number | null;
  color: string;
}

const FADE_MS = 450;
const WIDTH_PX = 5;

function lighten(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * f);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** Opacity of a stroke at [now]: full while drawn and for [holdMs] after, then a short fade. */
export function laserAlpha(s: LaserStroke, now: number, holdMs: number): number {
  if (s.liftedAt === null) return 1;
  const t = now - s.liftedAt - holdMs;
  return t <= 0 ? 1 : Math.max(0, 1 - t / FADE_MS);
}

/** A smooth curve through every point of [pts] (Catmull-Rom as cubic Béziers), so a fast circle stays round. */
export function tracePath(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  const n = pts.length;
  if (!n) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (n === 1) return ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    );
  }
}

/** Presenter annotations that stay until cleared: pen, or highlighter (wide and see-through). */
export interface InkStroke {
  kind: "pen" | "highlighter";
  pts: [number, number][];
  color: string;
  /** Content px. */
  width: number;
}

export function drawInk(ctx: CanvasRenderingContext2D, strokes: InkStroke[]) {
  for (const s of strokes) {
    if (!s.pts.length) continue;
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.globalAlpha = s.kind === "highlighter" ? 0.35 : 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    tracePath(ctx, s.pts);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Laser trail in XNotes' neon style (core/model/Stroke.kt paintNeon): a wide faint bloom, a tighter
 * bright bloom, the body lifted toward white, and a thin white-hot core. Width is constant on screen.
 */
export function drawLasers(ctx: CanvasRenderingContext2D, view: View, strokes: LaserStroke[], now: number, holdMs: number) {
  const dpr = ctx.getTransform().a / view.zoom;
  const w = WIDTH_PX / view.zoom;
  for (const s of strokes) {
    const a = laserAlpha(s, now, holdMs);
    if (a <= 0 || !s.pts.length) continue;
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    tracePath(ctx, s.pts);
    const pass = (color: string, width: number, alpha: number, blurPx: number) => {
      ctx.globalAlpha = a * alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.shadowColor = blurPx ? color : "transparent";
      ctx.shadowBlur = blurPx * dpr;
      ctx.stroke();
    };
    pass(s.color, w * 2.2, 0.42, 22);
    pass(s.color, w * 1.3, 0.85, 8);
    pass(lighten(s.color, 0.1), w, 1, 0);
    pass("#ffffff", w * 0.3, 1, 0);
    ctx.restore();
  }
}
