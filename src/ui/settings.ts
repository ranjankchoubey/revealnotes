import { useEffect, useState } from "react";

/** Device preferences (not part of a lesson). */
export interface Settings {
  /** Presenter camera zooms/scrolls to each step on large canvases. */
  cameraFollow: boolean;
  /** Seconds a laser stroke stays after the pen lifts before it fades. */
  laserSeconds: number;
  laserColor: string;
  /** "auto": once a stylus is used, the pen selects and fingers pan. */
  stylus: "auto" | "always" | "never";
  /** A stylus has been used on this device, so "auto" lets fingers pan from the moment a file opens. */
  stylusSeen: boolean;
  selectTool: "lasso" | "box";
  /** "touch": the boundary takes what it touches or surrounds; "inside": only what lies wholly within. */
  selectMode: "touch" | "inside";
  /** Numbered markers on each group of marked strokes in the editor. */
  badges: boolean;
  /** Exported lessons start with this device's presenter settings (camera follow, laser). */
  embedPresenter: boolean;
}

/** The settings an exported lesson carries. */
export type PresenterSettings = Pick<Settings, "cameraFollow" | "laserSeconds" | "laserColor">;

const KEY = "revealnotes:settings";
const VERSION = 2;
const DEFAULTS: Settings = {
  cameraFollow: true, laserSeconds: 2, laserColor: "#ff3b3b", stylus: "always", stylusSeen: false, selectTool: "lasso", selectMode: "touch", badges: true, embedPresenter: true,
};
export const LASER_COLORS = ["#ff3b3b", "#2ee66b", "#2e9bff", "#ffd400"];

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings> & { v?: number };
    // Older versions saved the then-default "auto" stylus with every change; let the new default win.
    if ((saved.v ?? 1) < 2 && saved.stylus === "auto") delete saved.stylus;
    delete saved.v;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<(s: Settings) => void>();
let current = typeof localStorage === "undefined" ? DEFAULTS : load();

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...current, v: VERSION }));
  } catch {
    // Preferences only.
  }
  for (const l of listeners) l(current);
}

export const getSettings = () => current;

export function presenterSettings(s: Settings = current): PresenterSettings {
  return { cameraFollow: s.cameraFollow, laserSeconds: s.laserSeconds, laserColor: s.laserColor };
}

/** An exported lesson's settings, for this viewing only: the viewer's own saved preferences stay as they are. */
export function applyLessonSettings(p: Partial<PresenterSettings> | undefined) {
  if (!p) return;
  const ok: Partial<Settings> = {};
  if (typeof p.cameraFollow === "boolean") ok.cameraFollow = p.cameraFollow;
  if (typeof p.laserSeconds === "number" && p.laserSeconds > 0 && p.laserSeconds <= 60) ok.laserSeconds = p.laserSeconds;
  if (typeof p.laserColor === "string" && /^#[0-9a-f]{6}$/i.test(p.laserColor)) ok.laserColor = p.laserColor;
  current = { ...current, ...ok };
  for (const l of listeners) l(current);
}

export function useSettings(): Settings {
  const [s, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    return () => void listeners.delete(set);
  }, []);
  return s;
}
