import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bounds, CanvasDoc, CanvasItem, Rgba } from "../format/xcanvas";
import { fitView, type PaperMode, type View } from "../render/draw";
import { boxRing, pickAt, ringMembers } from "../render/hit";
import { compactStages, usedStages, type Steps } from "../lesson/reveal";
import { CanvasView, ZOOM_STEP, zoomAt } from "./CanvasView";
import { Icon, IconButton } from "./icons";
import { useMedia } from "./useMedia";
import { setSettings, useSettings } from "./settings";
import { SettingsPanel } from "./SettingsPanel";

const STEP_COLORS: Rgba[] = [
  [255, 99, 132, 255], [54, 214, 140, 255], [77, 163, 255, 255], [255, 177, 66, 255], [180, 120, 255, 255],
  [64, 224, 208, 255], [255, 110, 220, 255], [200, 230, 80, 255], [255, 140, 90, 255], [140, 200, 255, 255],
];
const ALWAYS: Rgba = [200, 200, 210, 255];
export const stepColor = (s: number): Rgba => (s === 0 ? ALWAYS : STEP_COLORS[(s - 1) % STEP_COLORS.length]);
const css = (c: Rgba) => `rgb(${c[0]},${c[1]},${c[2]})`;

export type SaveState = "saved" | "unsaved" | "saving";

interface Props {
  doc: CanvasDoc;
  ids: string[];
  steps: Steps;
  paper: PaperMode;
  notice: string | null;
  saveState: SaveState;
  canUndo: boolean;
  onSteps: (next: Steps, record: boolean) => void;
  onUndo: () => void;
  onPaper: (p: PaperMode) => void;
  onSave: () => void;
  onExport: () => void;
  onLoadSteps: () => void;
  onPresent: () => void;
  onClose: () => void;
  onDismissNotice: () => void;
  /** IDs new or changed since the steps were saved, outlined until assigned. */
  fresh: Set<string>;
  onSeen: (ids: string[]) => void;
}

export function Editor(p: Props) {
  const { doc, ids } = p;
  const { stages, names } = p.steps;
  const idOf = useMemo(() => new Map(doc.items.map((it, i) => [it, ids[i]])), [doc, ids]);
  const stageOf = useCallback((it: CanvasItem) => stages.get(idOf.get(it)!) ?? 0, [stages, idOf]);
  const [view, setView] = useState<View | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [active, setActive] = useState(1);
  const [hover, setHover] = useState<CanvasItem | null>(null);
  const [box, setBox] = useState<Bounds | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [zoomLocked, setZoomLocked] = useState(false);
  const [noticeHidden, setNoticeHidden] = useState(false);
  useEffect(() => {
    setNoticeHidden(false);
    const t = setTimeout(() => setNoticeHidden(true), 7000);
    return () => clearTimeout(t);
  }, [p.notice, doc]);
  // Wide screens (laptop, landscape tablet) fit everything in one bar; narrow ones dock the steps at the bottom.
  const wide = useMedia("(min-width: 1100px)");
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lasso, setLasso] = useState<[number, number][] | null>(null);
  // Once a stylus is used (auto mode), the pen selects and a finger pans, like XNotes.
  const [penSeen, setPenSeen] = useState(false);
  const fingerPans = settings.stylus === "always" || (settings.stylus === "auto" && penSeen);
  const drag = useRef<{ x: number; y: number; moved: boolean; hit: CanvasItem | null; ring: [number, number][] } | null>(null);

  const steps = useMemo(() => {
    const s = new Set(usedStages(stages));
    if (active > 0) s.add(active);
    return [...s].sort((a, b) => a - b);
  }, [stages, active]);
  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of stages.values()) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  }, [stages]);
  const assignedAny = usedStages(stages).length > 0;

  const fit = useCallback(() => size.w > 0 && setView(fitView(doc.bounds, size.w, size.h, 16)), [doc, size]);
  // Keep the whole canvas fitted as the window resizes, until the user pans or zooms.
  const userMoved = useRef(false);
  useEffect(() => {
    if ((!view || !userMoved.current) && size.w > 0) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, fit]);

  const commit = useCallback(
    (stagesNext: Map<string, number>, namesNext: Map<number, string>, keep: number, record: boolean) => {
      const c = compactStages({ stages: stagesNext, names: namesNext }, keep);
      if (record || c.steps.stages !== stages || c.steps.names !== names) p.onSteps(c.steps, record);
      setActive(c.keep);
    },
    [stages, names, p],
  );
  const choose = useCallback((s: number) => commit(stages, names, s, false), [commit, stages, names]);
  const newStep = useCallback(() => choose((usedStages(stages).at(-1) ?? 0) + 1), [choose, stages]);
  // Linear order for ‹ ›: Always, Step 1, Step 2, …
  const order = useMemo(() => [0, ...steps], [steps]);
  const pos = order.indexOf(active);
  const step = useCallback((d: number) => {
    const i = pos + d;
    if (i >= 0 && i < order.length) choose(order[i]);
  }, [pos, order, choose]);

  const clearStep = (s: number) => {
    const next = new Map(stages);
    for (const [id, v] of next) if (v === s) next.set(id, 0);
    commit(next, names, active === s ? 0 : active, true);
  };

  const rename = (s: number, name: string) => {
    const next = new Map(names);
    if (name.trim()) next.set(s, name);
    else next.delete(s);
    p.onSteps({ stages, names: next }, false);
  };

  const apply = (items: CanvasItem[], toggle: boolean) => {
    if (items.length === 0) return;
    const next = new Map(stages);
    // Tapping a stroke that is already in the active step takes it back out.
    const turnOff = toggle && active !== 0 && items.every((it) => stageOf(it) === active);
    for (const it of items) next.set(idOf.get(it)!, turnOff ? 0 : active);
    commit(next, names, active, true);
    p.onSeen(items.map((it) => idOf.get(it)!));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Enter" || e.key === "Escape") e.target.blur();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "s") { e.preventDefault(); p.onSave(); }
      else if (mod && k === "z") { e.preventDefault(); p.onUndo(); }
      else if (mod) return;
      else if (/^[0-9]$/.test(e.key)) { const s = Number(e.key); if (s === 0 || steps.includes(s)) choose(s); }
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (k === "escape") setListOpen(false);
      else if (k === "n" || e.key === "+") newStep();
      else if (k === "p") p.onPresent();
      else if (k === "f") { userMoved.current = false; fit(); }
      else if (k === "l") setZoomLocked((z) => !z);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, steps, choose, newStep, fit, step]);

  const rect = (a: { x: number; y: number }, b: { x: number; y: number }): Bounds => ({
    minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
  });

  const zoomBy = (factor: number) => {
    if (!view || zoomLocked) return;
    userMoved.current = true;
    setView(zoomAt(view, size.w / 2, size.h / 2, factor));
  };
  const saveIcon = p.saveState === "saved" ? "check" : "save";
  const saveLabel = p.saveState === "saving" ? "Saving…" : p.saveState === "saved" ? "Saved" : "Save";

  const stepsGroup = (
    <div className={"steps" + (wide ? "" : " docked")}>
      {listOpen && (
        <div className="steplist">
          {steps.map((s) => (
            <div key={s} className={"row" + (s === active ? " active" : "")} style={{ "--c": css(stepColor(s)) } as React.CSSProperties}>
              <button className="dot" onClick={() => { choose(s); setListOpen(false); }} title={`Go to step ${s}`}>
                <i /> {s}
              </button>
              <input
                value={names.get(s) ?? ""}
                placeholder={`Step ${s} name`}
                onFocus={() => choose(s)}
                onChange={(e) => rename(s, e.target.value)}
              />
              <small>{counts.get(s) ?? 0}</small>
              {(counts.get(s) ?? 0) > 0 && (
                <IconButton icon="trash" onClick={() => clearStep(s)} title="Move this step's strokes back to Always" />
              )}
            </div>
          ))}
        </div>
      )}
      <button
        className={"chip" + (active === 0 ? " active" : "")}
        style={{ "--c": css(ALWAYS) } as React.CSSProperties}
        onClick={() => choose(0)}
        title="Visible from the start (key 0)"
      >
        Always <small>{counts.get(0) ?? 0}</small>
      </button>
      <IconButton icon="prev" onClick={() => step(-1)} disabled={pos <= 0} title="Previous step (←)" />
      <button
        className={"chip current" + (active > 0 ? " active" : "")}
        style={{ "--c": css(stepColor(active)) } as React.CSSProperties}
        onClick={() => setListOpen((o) => !o)}
        title="All steps: rename, clear"
      >
        {active > 0 ? (
          <><i /> <span className="label">{names.get(active) || `Step ${active}`}</span> <small>{active}/{steps.length}</small></>
        ) : (
          <>Steps <small>{steps.length}</small></>
        )}
        <Icon name="chevronDown" />
      </button>
      <IconButton icon="next" onClick={() => step(1)} disabled={pos >= order.length - 1} title="Next step (→)" />
      <IconButton icon="plus" onClick={newStep} title="New step at the end (N)" />
    </div>
  );

  return (
    <div className="editor">
      <header className="bar">
        <IconButton icon="back" onClick={p.onClose} title="Open another file" />
        <span className="title" title={doc.fileName}>{doc.fileName.replace(/\.(xcanvas|xnote)$/i, "")}</span>
        {wide ? stepsGroup : <span className="spacer" />}
        <div className="group">
          <IconButton icon="zoomOut" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={zoomLocked} title="Zoom out" />
          <button className="pct" onClick={() => { userMoved.current = false; fit(); }} title="Fit to screen (F)">
            {view ? Math.round(view.zoom * 100) : 100}%
          </button>
          <IconButton icon="zoomIn" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoomLocked} title="Zoom in" />
          <IconButton
            icon={zoomLocked ? "lock" : "unlock"}
            active={zoomLocked}
            onClick={() => setZoomLocked((z) => !z)}
            title={zoomLocked ? "Unlock zoom (L)" : "Lock zoom (L): pinch only pans, so tapping strokes can't zoom by accident"}
          />
        </div>
        <div className="group">
          <IconButton
            icon={settings.selectTool}
            onClick={() => setSettings({ selectTool: settings.selectTool === "lasso" ? "box" : "lasso" })}
            title={settings.selectTool === "lasso" ? "Selecting with lasso (tap for box)" : "Selecting with box (tap for lasso)"}
          />
          <IconButton icon="undo" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (⌘/Ctrl+Z)" />
          <IconButton icon={saveIcon} label={saveLabel} className={p.saveState === "unsaved" ? "attn" : ""} onClick={p.onSave} title="Save steps (⌘/Ctrl+S)" />
          <IconButton icon="gear" active={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} title="Settings, export, load steps" />
        </div>
        <IconButton icon="play" label="Present" className="primary" onClick={p.onPresent} title="Present (P)" />
      </header>
      {settingsOpen && (
        <SettingsPanel
          scope="edit"
          onClose={() => setSettingsOpen(false)}
          paper={p.paper}
          onPaper={p.onPaper}
          onLoadSteps={() => { setSettingsOpen(false); p.onLoadSteps(); }}
          onExport={() => { setSettingsOpen(false); p.onExport(); }}
        />
      )}

      <div className="stage">
        <CanvasView
          doc={doc}
          view={view}
          zoomLocked={zoomLocked}
          fingerPans={fingerPans}
          onView={(v) => {
            userMoved.current = true;
            setView(v);
          }}
          onSize={(w, h) => setSize({ w, h })}
          cursor={hover ? "pointer" : "crosshair"}
          onDown={(c) => {
            setListOpen(false);
            setSettingsOpen(false);
            if (c.event.pointerType === "pen") setPenSeen(true);
            drag.current = { x: c.x, y: c.y, moved: false, hit: pickAt(doc, c.x, c.y, 5 * c.scale), ring: [[c.x, c.y]] };
          }}
          onMove={(c) => {
            const d = drag.current;
            if (!d) {
              setHover(pickAt(doc, c.x, c.y, 5 * c.scale));
              return;
            }
            if (!d.moved && Math.hypot(c.x - d.x, c.y - d.y) / c.scale < 4) return;
            d.moved = true;
            setHover(null);
            if (settings.selectTool === "box") {
              setBox(rect(d, c));
              return;
            }
            const [lx, ly] = d.ring[d.ring.length - 1];
            // Decimate by on-screen spacing like XNotes (LASSO_MIN_STEP_PX = 3).
            if (Math.hypot(c.x - lx, c.y - ly) / c.scale >= 3) {
              d.ring.push([c.x, c.y]);
              setLasso([...d.ring]);
            }
          }}
          onUp={(c) => {
            const d = drag.current;
            drag.current = null;
            setBox(null);
            setLasso(null);
            if (!d) return;
            if (d.moved) {
              const ring = settings.selectTool === "box" ? boxRing(rect(d, c)) : [...d.ring, [c.x, c.y] as [number, number]];
              apply(ringMembers(doc.items, ring), false);
            } else if (d.hit) apply([d.hit], true);
          }}
          onCancel={() => {
            drag.current = null;
            setBox(null);
            setLasso(null);
          }}
          onLeave={() => setHover(null)}
          options={{
            paper: p.paper,
            halo: (it) => {
              const s = stageOf(it);
              if (s === 0) return undefined;
              // Current step glows; others stay faint so long lectures with repeating colours stay readable.
              const [r, g, b] = stepColor(s);
              return [r, g, b, s === active ? 160 : 40];
            },
            hover,
            marquee: box,
            lasso,
            flagged: p.fresh.size ? (it) => p.fresh.has(idOf.get(it)!) : undefined,
            accent: stepColor(active),
          }}
        />
        {!noticeHidden && (p.notice || doc.warnings.length > 0) && (
          <div className="notice" onClick={() => { setNoticeHidden(true); p.onDismissNotice(); }} title="Click to dismiss">
            {p.notice && <div>{p.notice}</div>}
            {doc.warnings.map((w) => <div key={w} className="muted">{w}</div>)}
          </div>
        )}
        {!assignedAny && (
          <div className="hint">
            Pick a step, then tap strokes or draw a loop around them.{" "}
            <button className="link" onClick={p.onLoadSteps}>Have a .reveal.json? Load it</button>
          </div>
        )}
      </div>

      {!wide && <footer className="bar bottom">{stepsGroup}</footer>}
    </div>
  );
}
