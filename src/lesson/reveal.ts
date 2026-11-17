import type { Bounds, CanvasDoc } from "../format/xcanvas";
import type { PaperMode, RevealStyle } from "../render/draw";

export interface Animation {
  style: RevealStyle;
  /** Multiplier on the base pace: 0.5 = half speed, 2 = double. */
  speed: number;
}
export const DEFAULT_ANIMATION: Animation = { style: "write", speed: 1 };
export const REVEAL_STYLES: RevealStyle[] = ["write", "fade", "rise", "pop", "wipe", "roll", "instant"];
const OLD_SPEEDS: Record<string, number> = { slow: 0.5, normal: 1, fast: 2 };

function parseSpeed(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? OLD_SPEEDS[v] : undefined;
  return n && Number.isFinite(n) ? Math.min(4, Math.max(0.25, n)) : DEFAULT_ANIMATION.speed;
}

export const REVEAL_FILE = "reveal.json";

export interface RevealObject {
  /** 0 = always visible, 1..n = reveal stage. */
  stage: number;
  /** z-order position when saved; informational only, never used for matching. */
  index?: number;
  /** Drawn bounds [minX, minY, maxX, maxY] when saved; lets a moved or touched-up stroke be found again. */
  box?: [number, number, number, number];
  [extra: string]: unknown;
}

export interface RevealFile {
  version: 1;
  app?: string;
  document: string;
  manifest_sha256: string;
  item_count?: number;
  paper?: PaperMode;
  /** How a step appears when presented. */
  animation?: Animation;
  /** Optional per-step metadata, keyed by step number. */
  steps?: Record<string, { name?: string }>;
  objects: Record<string, RevealObject>;
  [extra: string]: unknown;
}

export interface MatchReport {
  docChanged: boolean;
  docNameDiffers: boolean;
  /** Objects found by their exact fingerprint. */
  matched: number;
  /** Objects that changed (moved, touched up) but were found again by their saved box. */
  recovered: number;
  /** IDs assigned in reveal.json that no longer exist in the document. */
  missing: string[];
  /** Document objects that reveal.json does not know about. */
  added: number;
  addedIds: string[];
}

/** The editable part of a lesson: which step each object is in, and step names. */
export interface Steps {
  /** id -> step (0 = always visible) for every object in the document. */
  stages: Map<string, number>;
  names: Map<number, string>;
}

export interface Lesson extends Steps {
  /** The loaded file, kept so unknown fields and orphaned assignments are preserved on save. */
  base: RevealFile | null;
  paper: PaperMode;
  animation: Animation;
}

export function parseReveal(text: string): RevealFile {
  const v = JSON.parse(text) as RevealFile;
  if (!v || typeof v !== "object" || typeof v.objects !== "object" || v.objects === null) {
    throw new Error("reveal.json is missing its \"objects\" map.");
  }
  if (v.version !== 1) throw new Error(`reveal.json version ${String(v.version)} is not supported.`);
  return v;
}

const PAPER_KEY = "revealnotes:paper";

/** The last paper the user chose (light unless they picked dark). */
export function preferredPaper(): PaperMode {
  try {
    return localStorage.getItem(PAPER_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function rememberPaper(p: PaperMode) {
  try {
    localStorage.setItem(PAPER_KEY, p);
  } catch {
    // Preference only.
  }
}

export function newLesson(ids: string[]): Lesson {
  return { stages: new Map(ids.map((id) => [id, 0])), names: new Map(), base: null, paper: preferredPaper(), animation: DEFAULT_ANIMATION };
}

/** Apply a reveal file to the document by object ID (never by index) and report differences. */
export function applyReveal(doc: CanvasDoc, ids: string[], file: RevealFile): { lesson: Lesson; report: MatchReport } {
  const stages = new Map<string, number>();
  let matched = 0;
  const unmatched: number[] = [];
  ids.forEach((id, i) => {
    const o = file.objects[id];
    if (o && Number.isInteger(o.stage) && o.stage >= 0) {
      stages.set(id, o.stage);
      matched++;
    } else {
      stages.set(id, 0);
      unmatched.push(i);
    }
  });
  const present = new Set(ids);
  const orphans = Object.entries(file.objects).filter(([id, o]) => !present.has(id) && o.box && Number.isInteger(o.stage));
  const used = new Set<string>();
  const addedIds: string[] = [];
  let recovered = 0;
  for (const i of unmatched) {
    const best = findMoved(ids[i], doc.items[i].bounds, orphans, used);
    if (best) {
      used.add(best[0]);
      stages.set(ids[i], best[1].stage);
      recovered++;
    } else {
      addedIds.push(ids[i]);
    }
  }
  const missing = Object.keys(file.objects).filter((id) => !present.has(id) && !used.has(id));
  const names = new Map<number, string>();
  for (const [k, v] of Object.entries(file.steps ?? {})) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0 && typeof v?.name === "string" && v.name.trim()) names.set(n, v.name);
  }
  const a = file.animation;
  const animation: Animation = {
    style: a && REVEAL_STYLES.includes(a.style) ? a.style : DEFAULT_ANIMATION.style,
    speed: parseSpeed(a?.speed),
  };
  return {
    // The theme is this device's choice; a paper saved in the steps file doesn't override it.
    lesson: { stages, names, base: file, paper: preferredPaper(), animation },
    report: {
      docChanged: file.manifest_sha256 !== doc.manifestSha256,
      docNameDiffers: file.document !== doc.fileName,
      matched,
      recovered,
      missing,
      added: addedIds.length,
      addedIds,
    },
  };
}

/**
 * A saved object an edited one most likely was: same kind, and either the same size (moved, e.g. by
 * XNotes' lasso) or mostly overlapping (touched up in place). Nearest wins.
 */
function findMoved(id: string, b: Bounds, orphans: [string, RevealObject][], used: Set<string>): [string, RevealObject] | null {
  const kind = id.slice(0, id.indexOf("_"));
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  let best: [string, RevealObject] | null = null;
  let bestScore = Infinity;
  for (const entry of orphans) {
    const [oid, o] = entry;
    if (used.has(oid) || oid.slice(0, oid.indexOf("_")) !== kind) continue;
    const [x0, y0, x1, y1] = o.box!;
    const w0 = x1 - x0;
    const h0 = y1 - y0;
    const sameSize = Math.abs(w - w0) <= Math.max(2, 0.03 * w0) && Math.abs(h - h0) <= Math.max(2, 0.03 * h0);
    const ix = Math.max(0, Math.min(b.maxX, x1) - Math.max(b.minX, x0));
    const iy = Math.max(0, Math.min(b.maxY, y1) - Math.max(b.minY, y0));
    const inter = ix * iy;
    const iou = inter / Math.max(1e-9, w * h + w0 * h0 - inter);
    if (!sameSize && iou < 0.8) continue;
    const score = (1 - iou) * 1e4 + Math.hypot((b.minX + b.maxX - x0 - x1) / 2, (b.minY + b.maxY - y0 - y1) / 2);
    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

/** Build reveal.json, keeping unknown fields and per-object extras from the loaded file. */
export function serializeReveal(doc: CanvasDoc, ids: string[], lesson: Lesson, keepOrphans: boolean): RevealFile {
  const base = lesson.base;
  const objects: Record<string, RevealObject> = {};
  ids.forEach((id, index) => {
    const b = doc.items[index].bounds;
    const r = (v: number) => Math.round(v * 10) / 10;
    objects[id] = { ...(base?.objects[id] ?? {}), stage: lesson.stages.get(id) ?? 0, index, box: [r(b.minX), r(b.minY), r(b.maxX), r(b.maxY)] };
  });
  if (base && keepOrphans) {
    for (const [id, o] of Object.entries(base.objects)) if (!(id in objects)) objects[id] = o;
  }
  const steps: Record<string, { name?: string }> = {};
  for (const s of usedStages(lesson.stages)) {
    const name = lesson.names.get(s)?.trim();
    if (name) steps[String(s)] = { name };
  }
  return {
    ...(base ?? {}),
    version: 1,
    app: "RevealNotes",
    document: doc.fileName,
    manifest_sha256: doc.manifestSha256,
    item_count: ids.length,
    paper: lesson.paper,
    animation: lesson.animation,
    steps,
    objects,
  };
}

/** Sorted distinct reveal stages in use (excluding 0). */
export function usedStages(stages: Map<string, number>): number[] {
  return [...new Set([...stages.values()].filter((s) => s > 0))].sort((a, b) => a - b);
}

/** Renumber steps to 1..k with no gaps (names follow their step), keeping [keep] (the active step) even when empty. */
export function compactStages(steps: Steps, keep: number): { steps: Steps; keep: number } {
  const order = [...new Set([...usedStages(steps.stages), ...(keep > 0 ? [keep] : [])])].sort((a, b) => a - b);
  const map = new Map(order.map((s, i) => [s, i + 1]));
  const namesOk = [...steps.names.keys()].every((s) => map.get(s) === s);
  if (namesOk && order.every((s, i) => s === i + 1)) return { steps, keep };
  const stages = new Map<string, number>();
  for (const [id, s] of steps.stages) stages.set(id, s === 0 ? 0 : map.get(s)!);
  const names = new Map<number, string>();
  for (const [s, n] of steps.names) if (map.has(s)) names.set(map.get(s)!, n);
  return { steps: { stages, names }, keep: keep === 0 ? 0 : map.get(keep)! };
}

const draftKey = (sha: string) => `revealnotes:draft:${sha}`;
// Fallback by file name: after the notes are edited in XNotes the content hash changes, but the name doesn't.
const draftNameKey = (name: string) => `revealnotes:draft-name:${name}`;

/** Browser-local copy of the latest assignments, so reopening the same document restores them. */
export function saveDraft(file: RevealFile) {
  try {
    const text = JSON.stringify(file);
    localStorage.setItem(draftKey(file.manifest_sha256), text);
    localStorage.setItem(draftNameKey(file.document), text);
  } catch {
    // Storage full or disabled: the reveal.json file is still the source of truth.
  }
}

export function loadDraft(sha: string, name: string): RevealFile | null {
  try {
    const t = localStorage.getItem(draftKey(sha)) ?? localStorage.getItem(draftNameKey(name));
    return t ? parseReveal(t) : null;
  } catch {
    return null;
  }
}
