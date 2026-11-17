import { unzipSync, zipSync } from "fflate";
import type { PresenterSettings } from "../ui/settings";
import type { RevealFile } from "./reveal";

export const EMBED_ID = "revealnotes-data";
export const META_ID = "revealnotes-meta";

/** What a lessons site reads from an exported file without running it. */
export interface LessonMeta {
  title: string;
  steps: number;
  stepNames: string[];
  pages: number | null;
  exported: string;
  /** JPEG data URL, 16:9. */
  thumb: string;
}

export interface EmbeddedLesson {
  name: string;
  /** The original notes file, base64 (an .xnote's source PDF left out: [pdf] has its pages). */
  xcanvas: string;
  reveal: RevealFile;
  /** PDF backdrops as pictures, keyed "page:turn". */
  pdf?: Record<string, string>;
  /** The author's presenter settings, applied while this file is open. */
  presenter?: PresenterSettings;
}

/** The notes file without its source PDF (the export carries the pages as pictures instead). */
export function withoutPdf(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes);
  if (!entries["assets/source.pdf"]) return bytes;
  delete entries["assets/source.pdf"];
  return zipSync(entries);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * One self-contained HTML file: the presentation-only player bundle (player.js/.css, built next to the
 * app), inlined, plus the original notes file and its steps. Opens offline in any modern browser.
 */
export async function buildLessonHtml(lesson: EmbeddedLesson, meta?: LessonMeta): Promise<string> {
  const get = async (name: string) => {
    const res = await fetch(new URL(name, document.baseURI));
    if (!res.ok) throw new Error(`could not load ${name} (${res.status})`);
    return res.text();
  };
  const [js, css] = await Promise.all([get("player.js"), get("player.css")]);
  // Keep inlined code from ending its own tag early or opening an HTML comment.
  const safeJs = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  const data = JSON.stringify(lesson).replace(/</g, "\\u003c");
  const title = escapeHtml(meta?.title ?? lesson.name.replace(/\.(xcanvas|xnote)$/i, ""));
  const metaTags = meta
    ? `<meta name="description" content="${escapeHtml(`${meta.steps} steps`)}" />
<meta property="og:title" content="${title}" />
<script id="${META_ID}" type="application/json">${JSON.stringify(meta).replace(/</g, "\\u003c")}</script>
`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
<title>${title}</title>
${metaTags}<style>${safeCss}</style>
</head>
<body>
<div id="root"></div>
<script id="${EMBED_ID}" type="application/json">${data}</script>
<script type="module">${safeJs}</script>
</body>
</html>
`;
}

export function downloadText(name: string, text: string, type: string) {
  downloadBlob(name, new Blob([text], { type }));
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
