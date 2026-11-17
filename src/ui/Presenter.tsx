import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bounds, CanvasDoc, CanvasItem } from "../format/xcanvas";
import { fitView, type PaperMode, type View } from "../render/draw";
import { usedStages, type Steps } from "../lesson/reveal";
import { CanvasView, ZOOM_STEP, zoomAt } from "./CanvasView";
import { IconButton } from "./icons";
import { drawLasers, laserAlpha, type LaserStroke } from "../render/laser";
import { useSettings } from "./settings";
import { SettingsPanel } from "./SettingsPanel";

interface Props {
  doc: CanvasDoc;
  ids: string[];
  steps: Steps;
  paper: PaperMode;
  /** Omitted in an exported lesson, which has nothing to go back to. */
  onExit?: () => void;
}

type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

const isFullscreen = () => !!(document.fullscreenElement || (document as FsDoc).webkitFullscreenElement);

function toggleFullscreen() {
  const d = document as FsDoc;
  const el = document.documentElement as FsEl;
  if (isFullscreen()) {
    if (d.exitFullscreen) void d.exitFullscreen();
    else d.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) {
    void el.requestFullscreen().catch(() => {});
  } else {
    el.webkitRequestFullscreen?.();
  }
}

// Below this zoom (CSS px per content px) the whole canvas is too small to read, so the camera follows the steps.
const READABLE_ZOOM = 0.5;
const MAX_FOLLOW_ZOOM = 1.5;
const M = 16;
const TOP = 8;
const BOTTOM = 56;

function union(items: CanvasItem[]): Bounds | null {
  if (!items.length) return null;
  const b = { ...items[0].bounds };
  for (const it of items) {
    b.minX = Math.min(b.minX, it.bounds.minX);
    b.minY = Math.min(b.minY, it.bounds.minY);
    b.maxX = Math.max(b.maxX, it.bounds.maxX);
    b.maxY = Math.max(b.maxY, it.bounds.maxY);
  }
  return b;
}

export function Presenter({ doc, ids, steps: lesson, paper, onExit }: Props) {
  const stageOf = useMemo(() => {
    const m = new Map<CanvasItem, number>(doc.items.map((it, i) => [it, lesson.stages.get(ids[i]) ?? 0]));
    return (it: CanvasItem) => m.get(it) ?? 0;
  }, [doc, ids, lesson]);
  const steps = useMemo(() => usedStages(lesson.stages), [lesson]);
  // pos 0 = only "Always" objects; pos k = everything up to steps[k-1].
  const [pos, setPos] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hudVisible, setHudVisible] = useState(true);
  const [caption, setCaption] = useState<string | null>(null);
  const [zoomLocked, setZoomLocked] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const captionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anim = useRef(0);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const limit = pos === 0 ? 0 : steps[pos - 1];
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Laser: a stylus always draws it; laserOn lets a finger or mouse draw it too.
  const [laserOn, setLaserOn] = useState(false);
  const lasers = useRef<LaserStroke[]>([]);
  const drawing = useRef<LaserStroke | null>(null);
  const [, setLaserTick] = useState(0);
  const laserLoop = useRef(0);
  const holdMs = settings.laserSeconds * 1000;

  const runLaser = useCallback(() => {
    if (laserLoop.current) return;
    const tick = () => {
      const now = performance.now();
      lasers.current = lasers.current.filter((s) => laserAlpha(s, now, holdMs) > 0);
      setLaserTick((t) => t + 1);
      laserLoop.current = lasers.current.length ? requestAnimationFrame(tick) : 0;
    };
    laserLoop.current = requestAnimationFrame(tick);
  }, [holdMs]);

  // Keep the tablet's screen on while presenting.
  useEffect(() => {
    type WakeNav = Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };
    let lock: { release(): Promise<void> } | null = null;
    const acquire = () => {
      if (document.visibilityState === "visible") (navigator as WakeNav).wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
      cancelAnimationFrame(laserLoop.current);
    };
  }, []);

  const overview = useMemo(() => (size.w > 0 ? fitView(doc.bounds, size.w, size.h, M, TOP, BOTTOM) : null), [doc, size]);
  const follow = !!overview && settings.cameraFollow && overview.zoom < READABLE_ZOOM;

  /** Where the camera should be to show step [p], moving as little as possible from [cur]. */
  const viewFor = useCallback(
    (p: number, cur: View | null): View | null => {
      if (!overview) return null;
      if (!follow) return overview;
      const { w, h } = size;
      const whole = doc.bounds;
      const wholeW = whole.maxX - whole.minX;
      const base = Math.min(MAX_FOLLOW_ZOOM, Math.max(overview.zoom, (w - 2 * M) / Math.max(1, wholeW)));
      const target = union(doc.items.filter((it) => stageOf(it) === (p === 0 ? 0 : steps[p - 1])));
      const t = target ?? { minX: whole.minX, minY: whole.minY, maxX: whole.maxX, maxY: whole.minY + (h - TOP - BOTTOM) / base };
      const zoom = Math.min(base, fitView(t, w, h, M, TOP, BOTTOM).zoom);
      const fitsWide = wholeW * zoom <= w - 2 * M;
      const cx = fitsWide ? (whole.minX + whole.maxX) / 2 : (t.minX + t.maxX) / 2;
      const scrollX = cx - w / (2 * zoom);
      if (cur && Math.abs(cur.zoom - zoom) / zoom < 0.01) {
        // Same zoom: scroll just enough to bring the step into view, keeping the context above it.
        let scrollY = cur.scrollY;
        if (t.maxY > scrollY + (h - BOTTOM) / zoom) scrollY = t.maxY - (h - BOTTOM - M) / zoom;
        if (t.minY < scrollY + TOP / zoom) scrollY = t.minY - (TOP + M) / zoom;
        let sx = fitsWide ? scrollX : cur.scrollX;
        if (!fitsWide) {
          if (t.maxX > sx + (w - M) / zoom) sx = t.maxX - (w - M) / zoom;
          if (t.minX < sx + M / zoom) sx = t.minX - M / zoom;
        }
        return { zoom, scrollX: sx, scrollY };
      }
      const availH = h - TOP - BOTTOM;
      return { zoom, scrollX, scrollY: (t.minY + t.maxY) / 2 - (TOP + availH / 2) / zoom };
    },
    [overview, follow, size, doc, stageOf, steps],
  );

  const animateTo = useCallback(
    (to: View) => {
      cancelAnimationFrame(anim.current);
      const from = viewRef.current;
      const { w, h } = size;
      if (!from || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setView(to);
        return;
      }
      const c = (v: View) => ({ x: v.scrollX + w / (2 * v.zoom), y: v.scrollY + h / (2 * v.zoom) });
      const fc = c(from);
      const tc = c(to);
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / 380);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const zoom = from.zoom * (to.zoom / from.zoom) ** e;
        const x = fc.x + (tc.x - fc.x) * e;
        const y = fc.y + (tc.y - fc.y) * e;
        setView(k < 1 ? { zoom, scrollX: x - w / (2 * zoom), scrollY: y - h / (2 * zoom) } : to);
        if (k < 1) anim.current = requestAnimationFrame(tick);
      };
      anim.current = requestAnimationFrame(tick);
    },
    [size],
  );

  // Frame the current step whenever it changes; re-frame without animation on resize.
  const lastSize = useRef(size);
  useEffect(() => {
    const resized = lastSize.current !== size;
    lastSize.current = size;
    const v = viewFor(pos, resized ? null : viewRef.current);
    if (!v) return;
    if (resized || !viewRef.current) setView(v);
    else animateTo(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, size]);

  useEffect(() => {
    clearTimeout(captionTimer.current);
    const name = pos > 0 ? lesson.names.get(steps[pos - 1]) : undefined;
    setCaption(name ?? null);
    if (name) captionTimer.current = setTimeout(() => setCaption(null), 3500);
  }, [pos, lesson, steps]);

  const next = useCallback(() => setPos((q) => Math.min(steps.length, q + 1)), [steps]);
  const prev = useCallback(() => setPos((q) => Math.max(0, q - 1)), []);
  const all = useCallback(() => setPos(steps.length), [steps]);
  const restart = useCallback(() => setPos(0), []);
  const showOverview = useCallback(() => overview && animateTo(overview), [overview, animateTo]);
  const zoomBy = useCallback(
    (f: number) => {
      const v = viewRef.current;
      if (v && !zoomLocked) animateTo(zoomAt(v, size.w / 2, size.h / 2, f));
    },
    [zoomLocked, animateTo, size],
  );

  const pages = doc.pages && doc.pages.length > 1 ? doc.pages : null;
  const pageIndex = useMemo(() => {
    if (!pages || !view || !size.h) return 0;
    const cy = view.scrollY + size.h / (2 * view.zoom);
    const i = pages.findIndex((pg) => cy < pg.bounds.maxY + 24);
    return i < 0 ? pages.length - 1 : i;
  }, [pages, view, size]);
  const goPage = useCallback(
    (d: number) => {
      if (!pages) return;
      const pg = pages[Math.max(0, Math.min(pages.length - 1, pageIndex + d))];
      animateTo(fitView(pg.bounds, size.w, size.h, M, TOP, BOTTOM));
    },
    [pages, pageIndex, animateTo, size],
  );

  const poke = useCallback(() => {
    setHudVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHudVisible(false), 2500);
  }, []);

  useEffect(() => {
    poke();
    window.addEventListener("pointermove", poke);
    return () => {
      window.removeEventListener("pointermove", poke);
      clearTimeout(hideTimer.current);
      clearTimeout(captionTimer.current);
      cancelAnimationFrame(anim.current);
    };
  }, [poke]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        goPage(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      switch (e.key) {
        case "ArrowRight": case "ArrowDown": case " ": case "PageDown": case "Enter": e.preventDefault(); next(); break;
        case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": e.preventDefault(); prev(); break;
        case "a": case "A": all(); break;
        case "r": case "R": restart(); break;
        case "f": case "F": toggleFullscreen(); break;
        case "o": case "O": showOverview(); break;
        case "l": case "L": setZoomLocked((z) => !z); break;
        case "p": case "P": setLaserOn((on) => !on); break;
        case "+": case "=": zoomBy(ZOOM_STEP); break;
        case "-": case "_": zoomBy(1 / ZOOM_STEP); break;
        case "Escape": if (!isFullscreen()) onExit?.(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, all, restart, showOverview, onExit, goPage, zoomBy]);

  return (
    <div className="presenter">
      <CanvasView
        doc={doc}
        view={view}
        zoomLocked={zoomLocked}
        onView={(v) => {
          cancelAnimationFrame(anim.current);
          setView(v);
        }}
        onSize={(w, h) => setSize({ w, h })}
        onDown={(c) => {
          setSettingsOpen(false);
          if (c.event.pointerType === "pen" || laserOn) {
            drawing.current = { pts: [[c.x, c.y]], liftedAt: null, color: settings.laserColor };
            lasers.current.push(drawing.current);
            runLaser();
            return;
          }
          downAt.current = { x: c.event.clientX, y: c.event.clientY };
        }}
        onMove={(c) => {
          const s = drawing.current;
          if (!s) return;
          const [lx, ly] = s.pts[s.pts.length - 1];
          if (Math.hypot(c.x - lx, c.y - ly) / c.scale >= 1.5) s.pts.push([c.x, c.y]);
          runLaser();
        }}
        onCancel={() => {
          downAt.current = null;
          if (drawing.current) drawing.current.liftedAt = performance.now();
          drawing.current = null;
        }}
        onUp={(c) => {
          if (drawing.current) {
            drawing.current.liftedAt = performance.now();
            drawing.current = null;
            runLaser();
            return;
          }
          const d = downAt.current;
          downAt.current = null;
          if (!d || Math.hypot(c.event.clientX - d.x, c.event.clientY - d.y) > 8) return;
          // Tap the left quarter to go back, anywhere else to go forward.
          const r = c.event.currentTarget.getBoundingClientRect();
          if (c.event.clientX - r.left < r.width / 4) prev();
          else next();
        }}
        cursor={laserOn ? "crosshair" : hudVisible ? "default" : "none"}
        options={{
          paper,
          visible: (it) => stageOf(it) <= limit,
          overlay: (ctx, v) => drawLasers(ctx, v, lasers.current, performance.now(), holdMs),
        }}
      />
      {settingsOpen && <SettingsPanel scope="present" onClose={() => setSettingsOpen(false)} />}
      {caption && <div className="caption">{caption}</div>}
      <nav className={"hud" + (hudVisible || settingsOpen ? "" : " hidden")} onPointerDown={(e) => e.stopPropagation()}>
        {onExit && <IconButton icon="close" onClick={onExit} title="Back to editing (Esc)" />}
        <IconButton icon="prev" onClick={prev} disabled={pos === 0} title="Previous (←)" />
        <div className="dots" title={`${pos} of ${steps.length} steps shown`}>
          {steps.length <= 24
            ? steps.map((s, i) => <span key={s} className={i < pos ? "on" : ""} onClick={() => setPos(i + 1)} title={lesson.names.get(s) ?? `Step ${s}`} />)
            : <span className="count">{pos} / {steps.length}</span>}
          {steps.length === 0 && <span className="muted">no steps</span>}
        </div>
        <IconButton icon="next" onClick={next} disabled={pos === steps.length} title="Next (→ / Space)" />
        <IconButton
          icon={pos === steps.length ? "restart" : "revealAll"}
          onClick={pos === steps.length ? restart : all}
          title={pos === steps.length ? "Restart (R)" : "Reveal all (A)"}
        />
        <span className="sep" />
        <IconButton icon="zoomOut" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={zoomLocked} title="Zoom out (−)" />
        <IconButton icon="zoomIn" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoomLocked} title="Zoom in (+)" />
        <IconButton icon={zoomLocked ? "lock" : "unlock"} active={zoomLocked} onClick={() => setZoomLocked((z) => !z)} title={zoomLocked ? "Unlock zoom (L)" : "Lock zoom (L)"} />
        <IconButton icon="fit" onClick={showOverview} title="Whole canvas (O)" />
        {pages && (
          <>
            <span className="sep" />
            <IconButton icon="prev" className="rot90" onClick={() => goPage(-1)} disabled={pageIndex === 0} title="Previous page (Shift+←)" />
            <span className="page">p. {pageIndex + 1}/{pages.length}</span>
            <IconButton icon="next" className="rot90" onClick={() => goPage(1)} disabled={pageIndex === pages.length - 1} title="Next page (Shift+→)" />
          </>
        )}
        <span className="sep" />
        <IconButton
          icon="pen"
          active={laserOn}
          onClick={() => setLaserOn((on) => !on)}
          title={laserOn ? "Laser on: draw to point, it fades (P)" : "Laser pen for finger/mouse (P). A stylus always draws the laser."}
        />
        <IconButton icon="fullscreen" onClick={toggleFullscreen} title="Full screen (F)" />
        <IconButton icon="gear" active={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} title="Settings" />
      </nav>
    </div>
  );
}
