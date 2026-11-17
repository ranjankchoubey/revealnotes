// XNotes FontFace ids: four generic tokens, or a family name such as "Inter" (bundled in the app).
// A family the browser lacks falls back to sans, as XNotes does for a font it does not know.
const GENERIC: Record<string, string> = {
  mono: "ui-monospace, Menlo, Consolas, 'Roboto Mono', monospace",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  hand: "'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive",
};

export function fontFor(face: unknown, fallback = "mono"): string {
  const id = typeof face === "string" && face ? face : fallback;
  if (GENERIC[id]) return GENERIC[id];
  return `"${id.replace(/["\\]/g, "")}", ${GENERIC.sans}`;
}

/** XNotes sets type at a fixed 150 px per 72 pt. */
export const ptToPx = (pt: number) => pt * (150 / 72);

let measureCtx: OffscreenCanvasRenderingContext2D | null | undefined;
export function measure(text: string, font: string, size: number): number {
  if (measureCtx === undefined) measureCtx = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1).getContext("2d") : null;
  if (!measureCtx) return text.length * size * 0.6;
  measureCtx.font = `${size}px ${font}`;
  return measureCtx.measureText(text).width;
}

/** Word-wrapped lines of [text] no wider than [width]; explicit newlines kept. */
export function wrap(text: string, width: number, font: string, size: number): string[] {
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

/** Width of the longest line, unwrapped. */
export const naturalWidth = (text: string, font: string, size: number) =>
  Math.max(0, ...text.split("\n").map((l) => measure(l, font, size)));
