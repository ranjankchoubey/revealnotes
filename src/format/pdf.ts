// PDF page backdrops for .xnote files, drawn with pdf.js. The library is loaded at runtime from
// ./pdfjs/ (copied there by the build), so neither the app bundle nor exported lessons carry it.
import type * as Pdfjs from "pdfjs-dist";
import type { CanvasDoc, PdfBackdrop } from "./xcanvas";

type PdfLib = typeof Pdfjs;

let lib: Promise<PdfLib> | null = null;

function loadLib(): Promise<PdfLib> {
  if (!lib) {
    const base = new URL("./pdfjs/", document.baseURI).href;
    lib = (import(/* @vite-ignore */ base + "pdf.min.mjs") as Promise<PdfLib>).then((m) => {
      m.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
      return m;
    });
    lib.catch(() => (lib = null));
  }
  return lib;
}

// Rendered pages kept at once, in pixels (about 160 MB of canvas memory).
const PIXEL_BUDGET = 40e6;
const MIN_WIDTH = 256;
const MAX_WIDTH = 3072;

interface Rendered {
  canvas: HTMLCanvasElement;
  width: number;
  used: number;
}

class PdfRenderer implements PdfBackdrop {
  private cache = new Map<string, Rendered>();
  private queue: { key: string; index: number; turn: number; width: number; onReady: () => void }[] = [];
  private busy = false;
  private tick = 0;

  constructor(private pdf: Pdfjs.PDFDocumentProxy) {}

  page(index: number, turn: number, pxWide: number, onReady: () => void): CanvasImageSource | null {
    if (index >= this.pdf.numPages) return null;
    const key = `${index}:${turn}`;
    // Power-of-two widths so zooming re-renders only when the page would look soft.
    const want = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 2 ** Math.ceil(Math.log2(Math.max(1, pxWide)))));
    const have = this.cache.get(key);
    if (have) have.used = ++this.tick;
    if ((!have || have.width < want) && !this.queue.some((q) => q.key === key && q.width >= want)) {
      this.queue = this.queue.filter((q) => q.key !== key);
      this.queue.push({ key, index, turn, width: want, onReady });
      void this.pump();
    }
    return have?.canvas ?? null;
  }

  /** One page at a time, the latest request first, so the page on screen wins. */
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.pop()!;
        try {
          const canvas = await renderPage(this.pdf, job.index, job.turn, job.width);
          this.cache.set(job.key, { canvas, width: job.width, used: ++this.tick });
          this.evict();
          job.onReady();
        } catch {
          // A page pdf.js cannot draw stays plain paper.
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private evict() {
    let total = 0;
    for (const r of this.cache.values()) total += r.canvas.width * r.canvas.height;
    const byAge = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, r] of byAge) {
      if (total <= PIXEL_BUDGET || this.cache.size <= 1) break;
      total -= r.canvas.width * r.canvas.height;
      r.canvas.width = r.canvas.height = 0;
      this.cache.delete(key);
    }
  }
}

async function renderPage(pdf: Pdfjs.PDFDocumentProxy, index: number, turn: number, width: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(index + 1);
  const rotation = (page.rotate + 90 * turn) % 360;
  const unit = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: width / unit.width, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

/** Opens the note's PDF so its pages draw behind the ink. Throws when pdf.js cannot read it. */
export async function attachPdf(doc: CanvasDoc): Promise<void> {
  if (!doc.pdfBytes || doc.pdf) return;
  const m = await loadLib();
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await m.getDocument({ data: doc.pdfBytes.slice() }).promise;
  doc.pdf = new PdfRenderer(pdf);
}

/**
 * Each PDF page the note shows, as a JPEG data URL [scale]× the page's size, for exported lessons
 * (which draw these pictures instead of loading pdf.js). Keyed "page:turn".
 */
export async function pdfPictures(doc: CanvasDoc, scale = 1.5, quality = 0.85): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!doc.pdfBytes || !doc.pages) return out;
  const m = await loadLib();
  const task = m.getDocument({ data: doc.pdfBytes.slice() });
  const pdf = await task.promise;
  try {
    for (const pg of doc.pages) {
      if (pg.pdfPage === null || pg.pdfPage >= pdf.numPages) continue;
      const key = `${pg.pdfPage}:${pg.pdfTurn}`;
      if (out[key]) continue;
      const w = Math.min(MAX_WIDTH, Math.round((pg.bounds.maxX - pg.bounds.minX) * scale));
      const canvas = await renderPage(pdf, pg.pdfPage, pg.pdfTurn, w);
      out[key] = canvas.toDataURL("image/jpeg", quality);
      canvas.width = canvas.height = 0;
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/** The backdrop an exported lesson draws: the pictures made by [pdfPictures]. */
export function pictureBackdrop(pictures: Record<string, string>): PdfBackdrop {
  const images = new Map<string, HTMLImageElement>();
  return {
    page(index, turn, _pxWide, onReady) {
      const key = `${index}:${turn}`;
      const src = pictures[key];
      if (!src) return null;
      let img = images.get(key);
      if (!img) {
        img = new Image();
        img.onload = onReady;
        img.src = src;
        images.set(key, img);
      }
      return img.complete && img.naturalWidth > 0 ? img : null;
    },
  };
}
