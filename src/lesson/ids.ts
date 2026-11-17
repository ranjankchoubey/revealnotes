import type { CanvasDoc } from "../format/xcanvas";

// Fields that can change without the drawn object changing (lasso group, lock, glue id, audio sync).
const VOLATILE = new Set(["group", "locked", "id", "rec", "rec_ms"]);

function canonical(v: unknown, top: boolean): string {
  if (Array.isArray(v)) return "[" + v.map((x) => canonical(x, false)).join(",") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).filter((k) => !(top && VOLATILE.has(k))).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k], false)).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** cyrb53: fast 53-bit string hash. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Stable object IDs. XNotes stores none, so each item is identified by a fingerprint of its own
 * content (kind, tool, style, samples/geometry). Reordering items keeps every ID; editing or moving
 * an item changes its ID. Exact duplicates get "-2", "-3"... in z-order.
 */
export function objectIds(doc: CanvasDoc): string[] {
  const seen = new Map<string, number>();
  return doc.items.map((it) => {
    const kind = typeof it.raw.kind === "string" ? it.raw.kind : "item";
    const where = it.page === undefined ? "" : `@page${it.page}`;
    const base = `${kind}_${cyrb53(canonical(it.raw, true) + where).toString(16).padStart(14, "0")}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}
