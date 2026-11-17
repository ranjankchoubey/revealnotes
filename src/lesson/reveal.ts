import type { CanvasDoc } from "../format/xcanvas";
import type { PaperMode } from "../render/draw";

export const REVEAL_FILE = "reveal.json";

export interface RevealObject {
  /** 0 = always visible, 1..n = reveal stage. */
  stage: number;
  /** z-order position when saved; informational only, never used for matching. */
  index?: number;
  [extra: string]: unknown;
}

export interface RevealFile {
  version: 1;
  app?: string;
  document: string;
  manifest_sha256: string;
  item_count?: number;
  paper?: PaperMode;
  /** Optional per-step metadata, keyed by step number. */
  steps?: Record<string, { name?: string }>;
  objects: Record<string, RevealObject>;
  [extra: string]: unknown;
}

export interface MatchReport {
  docChanged: boolean;
  docNameDiffers: boolean;
  matched: number;
  /** IDs assigned in reveal.json that no longer exist in the document. */
  missing: string[];
  /** Document objects that reveal.json does not know about. */
  added: number;
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
}

export function parseReveal(text: string): RevealFile {
  const v = JSON.parse(text) as RevealFile;
  if (!v || typeof v !== "object" || typeof v.objects !== "object" || v.objects === null) {
    throw new Error("reveal.json is missing its \"objects\" map.");
  }
  if (v.version !== 1) throw new Error(`reveal.json version ${String(v.version)} is not supported.`);
  return v;
}

export function newLesson(ids: string[]): Lesson {
  return { stages: new Map(ids.map((id) => [id, 0])), names: new Map(), base: null, paper: "dark" };
}

/** Apply a reveal file to the document by object ID (never by index) and report differences. */
export function applyReveal(doc: CanvasDoc, ids: string[], file: RevealFile): { lesson: Lesson; report: MatchReport } {
  const stages = new Map<string, number>();
  let matched = 0;
  let added = 0;
  for (const id of ids) {
    const o = file.objects[id];
    if (o && Number.isInteger(o.stage) && o.stage >= 0) {
      stages.set(id, o.stage);
      matched++;
    } else {
      stages.set(id, 0);
      added++;
    }
  }
  const present = new Set(ids);
  const missing = Object.keys(file.objects).filter((id) => !present.has(id));
  const names = new Map<number, string>();
  for (const [k, v] of Object.entries(file.steps ?? {})) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0 && typeof v?.name === "string" && v.name.trim()) names.set(n, v.name);
  }
  return {
    lesson: { stages, names, base: file, paper: file.paper === "light" ? "light" : "dark" },
    report: {
      docChanged: file.manifest_sha256 !== doc.manifestSha256,
      docNameDiffers: file.document !== doc.fileName,
      matched,
      missing,
      added,
    },
  };
}

/** Build reveal.json, keeping unknown fields and per-object extras from the loaded file. */
export function serializeReveal(doc: CanvasDoc, ids: string[], lesson: Lesson, keepOrphans: boolean): RevealFile {
  const base = lesson.base;
  const objects: Record<string, RevealObject> = {};
  ids.forEach((id, index) => {
    objects[id] = { ...(base?.objects[id] ?? {}), stage: lesson.stages.get(id) ?? 0, index };
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

/** Browser-local copy of the latest assignments, so reopening the same document restores them. */
export function saveDraft(file: RevealFile) {
  try {
    localStorage.setItem(draftKey(file.manifest_sha256), JSON.stringify(file));
  } catch {
    // Storage full or disabled: the reveal.json file is still the source of truth.
  }
}

export function loadDraft(sha: string): RevealFile | null {
  try {
    const t = localStorage.getItem(draftKey(sha));
    return t ? parseReveal(t) : null;
  } catch {
    return null;
  }
}
