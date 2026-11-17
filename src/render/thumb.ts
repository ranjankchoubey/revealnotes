import type { CanvasDoc } from "../format/xcanvas";
import { fitView, render, type PaperMode } from "./draw";

/** A 16:9 JPEG of the finished notes (first page of a notebook), for lesson cards. */
export async function makeThumbnail(doc: CanvasDoc, paper: PaperMode, w = 640, h = 360): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  let target = doc.pages?.[0]?.bounds ?? doc.bounds;
  if (!doc.pages) {
    // A long canvas squeezed whole is unreadable on a card: show where it starts instead.
    const bw = target.maxX - target.minX;
    const bh = target.maxY - target.minY;
    if (bh > (bw * h) / w * 1.4) target = { ...target, maxY: target.minY + (bw * h) / w };
    else if (bw > (bh * w) / h * 1.4) target = { ...target, maxX: target.minX + (bh * w) / h };
  }
  let waiting = false;
  const draw = () => {
    waiting = false;
    render(ctx, { doc, view: fitView(target, w, h, 12), width: w, height: h, paper, onAsset: () => (waiting = true) });
  };
  draw();
  // Pictures and PDF pages load asynchronously; redraw while they arrive (briefly).
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!waiting && i > 0) break;
    draw();
  }
  return canvas.toDataURL("image/jpeg", 0.8);
}
