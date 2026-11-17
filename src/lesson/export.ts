import type { RevealFile } from "./reveal";

export const EMBED_ID = "revealnotes-data";

export interface EmbeddedLesson {
  name: string;
  /** The original .xcanvas file, base64. */
  xcanvas: string;
  reveal: RevealFile;
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
 * One self-contained HTML file: this app's own script and styles, inlined, plus the original
 * .xcanvas and its steps. It opens offline in any modern browser and starts in presentation mode.
 */
export async function buildLessonHtml(lesson: EmbeddedLesson): Promise<string> {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!script) throw new Error("Export is not available here.");
  const js = await (await fetch(script.src)).text();
  let css = "";
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) css += await (await fetch(l.href)).text();
  for (const s of document.querySelectorAll("style")) css += s.textContent ?? "";
  // Keep inlined text from closing its own tag early.
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  const data = JSON.stringify(lesson).replace(/</g, "\\u003c");
  const title = escapeHtml(lesson.name.replace(/\.xcanvas$/i, ""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
<title>${title}</title>
<style>${safeCss}</style>
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
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
