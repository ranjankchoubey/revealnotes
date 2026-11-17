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
  selectTool: "lasso" | "box";
  /** Numbered markers on each group of marked strokes in the editor. */
  badges: boolean;
}

const KEY = "revealnotes:settings";
const DEFAULTS: Settings = { cameraFollow: true, laserSeconds: 2, laserColor: "#ff3b3b", stylus: "auto", selectTool: "lasso", badges: true };
export const LASER_COLORS = ["#ff3b3b", "#2ee66b", "#2e9bff", "#ffd400"];

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<(s: Settings) => void>();
let current = typeof localStorage === "undefined" ? DEFAULTS : load();

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Preferences only.
  }
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
