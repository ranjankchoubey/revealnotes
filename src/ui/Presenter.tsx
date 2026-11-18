import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bounds, CanvasDoc, CanvasItem, TapeItem } from "../format/xcanvas";
import { fitView, strokeArc, type PaperMode, type View } from "../render/draw";
import { hitItem } from "../render/hit";
import { usedStages, type Animation, type Steps } from "../lesson/reveal";
import { CanvasView, ZOOM_STEP, zoomAt } from "./CanvasView";
import { IconButton } from "./icons";
import { drawInk, drawLasers, laserAlpha, type InkStroke, type LaserStroke } from "../render/laser";
import { downloadBlob } from "../lesson/export";
import { canRecord, formatTime, Recorder, videoExtension } from "./recorder";
import { useSettings, setSettings } from "./settings";
import { SettingsPanel } from "./SettingsPanel";

interface Props {
  doc: CanvasDoc;
  ids: string[];
  steps: Steps;
  paper: PaperMode;
  animation: Animation;
  /** Lets the presenter's settings change the lesson's reveal style; omitted in exported files. */
  onAnimation?: (a: Animation) => void;
  /** Omitted in an exported lesson, which has nothing to go back to. */
  onExit?: () => void;
  /** Offers video recording, saving as "<name> <date>.mp4"; omitted in exported lessons. */
  recordName?: string;
  exitTitle?: string;
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

type Tool = "tap" | "laser" | "pen" | "highlighter" | "eraser";
const PEN_COLORS = ["#e5353b", "#1e66f5", "#1b1b1f", "#16a34a"];
const MARKER_COLORS = ["#ffd400", "#7cfc00", "#00e5ff", "#ff6ec7"];
// Screen px at the zoom the stroke was drawn at; the ink then zooms with the notes.
const PEN_PX = 3;
const MARKER_PX = 18;

function distanceToSegmentSquared(x: number, y: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) : 0;
  return (x - (a[0] + t * dx)) ** 2 + (y - (a[1] + t * dy)) ** 2;
}

function inkTouchesPoint(stroke: InkStroke, x: number, y: number, radius: number) {
  const r = radius + stroke.width / 2;
  const limit = r * r;
  if (stroke.pts.length === 1) return distanceToSegmentSquared(x, y, stroke.pts[0], stroke.pts[0]) <= limit;
  return stroke.pts.slice(1).some((point, i) => distanceToSegmentSquared(x, y, stroke.pts[i], point) <= limit);
}

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

export function Presenter({ doc, ids, steps: lesson, paper, onExit, animation, onAnimation, recordName, exitTitle = "Back to editing (Esc)" }: Props) {
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
  const downAt = useRef<{ x: number; y: number; view: View | null; panning: boolean } | null>(null);
  const limit = pos === 0 ? 0 : steps[pos - 1];
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Tapes peeled back this session (never saved, as in XNotes).
  const [peeled, setPeeled] = useState<Set<TapeItem>>(() => new Set());
  // Tools: "tap" advances; laser fades; pen and highlighter stay until cleared (never saved).
  // A stylus always draws (the laser while on tap); once one is used, fingers keep tapping.
  const [tool, setTool] = useState<Tool>("tap");
  const [inkColors, setInkColors] = useState({ pen: PEN_COLORS[0], highlighter: MARKER_COLORS[0] });
  const ink = useRef<InkStroke[]>([]);
  const inking = useRef<InkStroke | null>(null);
  const erasing = useRef(false);
  const [inkCount, setInkCount] = useState(0);
  const pickTool = useCallback((t: Tool) => setTool((cur) => (cur === t ? "tap" : t)), []);
  const clearInk = useCallback(() => {
    ink.current = [];
    setInkCount(0);
  }, []);
  const undoInk = useCallback(() => {
    ink.current = ink.current.slice(0, -1);
    setInkCount(ink.current.length);
  }, []);
  const eraseInk = useCallback((x: number, y: number, scale: number) => {
    const remaining = ink.current.filter((stroke) => !inkTouchesPoint(stroke, x, y, 12 * scale));
    if (remaining.length === ink.current.length) return;
    ink.current = remaining;
    setInkCount(remaining.length);
  }, []);
  const lasers = useRef<LaserStroke[]>([]);
  const drawing = useRef<LaserStroke | null>(null);
  const [, setLaserTick] = useState(0);
  const laserLoop = useRef(0);
  const holdMs = settings.laserSeconds * 1000;

  // Video: the framed canvas plus the microphone. Pause any time; Next stays manual.
  const rootRef = useRef<HTMLDivElement>(null);
  const recorder = useRef<Recorder | null>(null);
  const [rec, setRec] = useState<"idle" | "mic" | "countdown" | "recording" | "paused">("idle");
  const [count, setCount] = useState(0);
  const [, setRecTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelCountdown = useRef(false);
  const say = useCallback((m: string) => {
    clearTimeout(msgTimer.current);
    setMessage(m);
    msgTimer.current = setTimeout(() => setMessage(null), 5000);
  }, []);

  const saveVideo = useCallback(
    async (r: Recorder) => {
      const length = formatTime(r.elapsed());
      const blob = await r.stop();
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
      const name = `${recordName ?? "lesson"} ${stamp}.${videoExtension(r.mime)}`;
      downloadBlob(name, blob);
      return `Saved ${name} (${length}) to your downloads.`;
    },
    [recordName],
  );

  const startRecording = useCallback(async () => {
    if (rec !== "idle") return;
    setRec("mic");
    const mic = await Recorder.askMic();
    cancelCountdown.current = false;
    setRec("countdown");
    for (let n = 3; n > 0; n--) {
      setCount(n);
      await new Promise((res) => setTimeout(res, 1000));
      if (cancelCountdown.current) {
        for (const t of mic?.getTracks() ?? []) t.stop();
        setRec("idle");
        return;
      }
    }
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg") || "#fff";
    recorder.current = new Recorder(() => rootRef.current?.querySelector("canvas") ?? null, bg, mic);
    setRec("recording");
    if (!mic) say("Recording without sound: the microphone is blocked or missing.");
  }, [rec, say]);

  const togglePause = useCallback(() => {
    const r = recorder.current;
    if (rec === "countdown") {
      cancelCountdown.current = true;
      return;
    }
    if (!r) return;
    if (r.paused) {
      r.resume();
      setRec("recording");
    } else {
      r.pause();
      setRec("paused");
    }
  }, [rec]);

  const stopRecording = useCallback(async () => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    setRec("idle");
    say(await saveVideo(r));
  }, [saveVideo, say]);

  useEffect(() => {
    if (rec !== "recording" && rec !== "paused") return;
    const t = setInterval(() => setRecTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [rec]);

  // Leaving the presenter mid-recording keeps what was recorded.
  const saveRef = useRef(saveVideo);
  saveRef.current = saveVideo;
  useEffect(
    () => () => {
      cancelCountdown.current = true;
      clearTimeout(msgTimer.current);
      const r = recorder.current;
      recorder.current = null;
      if (r) void saveRef.current(r);
    },
    [],
  );
  const recording = rec === "recording" || rec === "paused" || rec === "countdown";

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

  // The step being revealed: per-item [start, end] ms from `start`.
  const revealing = useRef<{ start: number; total: number; sched: Map<CanvasItem, [number, number]>; area: Bounds } | null>(null);
  const [, setRevealTick] = useState(0);
  const revealLoop = useRef(0);

  const startReveal = useCallback(
    (stage: number) => {
      cancelAnimationFrame(revealLoop.current);
      revealing.current = null;
      if (animation.style === "instant" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const items = doc.items.filter((it) => stageOf(it) === stage);
      const area = union(items);
      if (!area) return;
      const f = animation.speed;
      const sched = new Map<CanvasItem, [number, number]>();
      let total = 0;
      if (animation.style === "write") {
        // Strokes replay one after another in the order they were written, at a steady pen speed.
        const speed = 1400 * f;
        const durs = items.map((it) => (it.kind === "stroke" ? Math.max(60, (strokeArc(it).at(-1)! / speed) * 1000) : 250 / f));
        const sum = durs.reduce((a, b) => a + b, 0);
        const scale = sum > 6000 / f ? 6000 / f / sum : 1;
        items.forEach((it, i) => {
          sched.set(it, [total, total + durs[i] * scale]);
          total += durs[i] * scale;
        });
      } else {
        const base = { fade: 500, rise: 600, pop: 450, wipe: 800, roll: 800 }[animation.style as "fade"] / f;
        // Rise and pop cascade through the step in writing order; fade and the sweeps move as one.
        const cascade = animation.style === "rise" || animation.style === "pop";
        const gap = cascade ? Math.min(70 / f, (base * 1.2) / Math.max(1, items.length)) : 0;
        items.forEach((it, i) => sched.set(it, [i * gap, i * gap + base]));
        total = base + gap * (items.length - 1);
      }
      revealing.current = { start: performance.now(), total, sched, area };
      const tick = () => {
        const r = revealing.current;
        if (r && performance.now() - r.start >= r.total) revealing.current = null;
        setRevealTick((t) => t + 1);
        if (revealing.current) revealLoop.current = requestAnimationFrame(tick);
      };
      revealLoop.current = requestAnimationFrame(tick);
    },
    [animation, doc, stageOf],
  );
  const stopReveal = () => {
    cancelAnimationFrame(revealLoop.current);
    revealing.current = null;
  };

  const next = useCallback(() => {
    if (pos >= steps.length) return;
    startReveal(steps[pos]);
    setPos(pos + 1);
  }, [pos, steps, startReveal]);
  const prev = useCallback(() => {
    stopReveal();
    setPos((q) => Math.max(0, q - 1));
  }, []);
  const all = useCallback(() => {
    stopReveal();
    setPos(steps.length);
  }, [steps]);
  const restart = useCallback(() => {
    stopReveal();
    setPos(0);
    clearInk();
  }, [clearInk]);
  const showOverview = useCallback(() => overview && animateTo(overview), [overview, animateTo]);
  /** XNotes' fit width / fit height, of the page in view (notebooks) or the whole canvas. */
  const fitAxis = useCallback(
    (axis: "width" | "height") => {
      const v = viewRef.current;
      if (!v || size.w === 0) return;
      const cy = v.scrollY + size.h / (2 * v.zoom);
      const t = doc.pages?.find((pg) => cy < pg.bounds.maxY + 24)?.bounds ?? doc.bounds;
      if (axis === "width") {
        const zoom = (size.w - 2 * M) / Math.max(1, t.maxX - t.minX);
        // A notebook page starts at its top; a canvas keeps the spot in view centred.
        animateTo({ zoom, scrollX: t.minX - M / zoom, scrollY: doc.pages ? t.minY - M / zoom : cy - size.h / (2 * zoom) });
      } else {
        const zoom = (size.h - TOP - BOTTOM) / Math.max(1, t.maxY - t.minY);
        animateTo({ zoom, scrollX: (t.minX + t.maxX) / 2 - size.w / (2 * zoom), scrollY: t.minY - TOP / zoom });
      }
    },
    [doc, size, animateTo],
  );
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
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undoInk();
        return;
      }
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
        case "w": case "W": fitAxis("width"); break;
        case "h": case "H": fitAxis("height"); break;
        case "l": case "L": setZoomLocked((z) => !z); break;
        case "p": case "P": pickTool("laser"); break;
        case "d": case "D": pickTool("pen"); break;
        case "m": case "M": pickTool("highlighter"); break;
        case "e": case "E": pickTool("eraser"); break;
        case "c": case "C": clearInk(); break;
        case "k": case "K": togglePause(); break;
        case "+": case "=": zoomBy(ZOOM_STEP); break;
        case "-": case "_": zoomBy(1 / ZOOM_STEP); break;
        case "Escape": if (!isFullscreen()) onExit?.(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, all, restart, showOverview, onExit, goPage, zoomBy, fitAxis, togglePause, pickTool, clearInk, undoInk]);

  return (
    <div className={"presenter" + (recording ? " recording" : "")} ref={rootRef}>
      <CanvasView
        className={recording ? "framed" : undefined}
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
          erasing.current = false;
          const kind = c.event.pointerType;
          if (kind === "pen" && !settings.stylusSeen) setSettings({ stylusSeen: true });
          const fingersTap = settings.stylus === "always" || (settings.stylus === "auto" && (settings.stylusSeen || kind === "pen"));
          const use: Tool = kind === "pen" ? (tool === "tap" ? "laser" : tool) : kind === "touch" && fingersTap ? "tap" : tool;
          if (use === "laser") {
            drawing.current = { pts: [[c.x, c.y]], liftedAt: null, color: settings.laserColor };
            lasers.current.push(drawing.current);
            runLaser();
            return;
          }
          if (use === "eraser") {
            erasing.current = true;
            eraseInk(c.x, c.y, c.scale);
            return;
          }
          if (use === "pen" || use === "highlighter") {
            inking.current = { kind: use, pts: [[c.x, c.y]], color: inkColors[use], width: (use === "pen" ? PEN_PX : MARKER_PX) * c.scale };
            ink.current = [...ink.current, inking.current];
            setInkCount(ink.current.length);
            return;
          }
          downAt.current = { x: c.event.clientX, y: c.event.clientY, view: viewRef.current, panning: false };
        }}
        onMove={(c) => {
          const d = downAt.current;
          if (d?.view) {
            // A tap advances; a drag scrolls the notes, as one finger does everywhere else.
            const dx = c.event.clientX - d.x;
            const dy = c.event.clientY - d.y;
            if (!d.panning && Math.hypot(dx, dy) > 8) d.panning = true;
            if (d.panning) {
              cancelAnimationFrame(anim.current);
              setView({ ...d.view, scrollX: d.view.scrollX - dx / d.view.zoom, scrollY: d.view.scrollY - dy / d.view.zoom });
            }
            return;
          }
          if (erasing.current) {
            for (const [x, y] of c.samples) eraseInk(x, y, c.scale);
            return;
          }
          const s = drawing.current ?? inking.current;
          if (!s) return;
          for (const [x, y] of c.samples) {
            const [lx, ly] = s.pts[s.pts.length - 1];
            if (Math.hypot(x - lx, y - ly) / c.scale >= 0.75) s.pts.push([x, y]);
          }
          if (drawing.current) runLaser();
          else setLaserTick((t) => t + 1);
        }}
        onCancel={() => {
          downAt.current = null;
          erasing.current = false;
          if (drawing.current) drawing.current.liftedAt = performance.now();
          drawing.current = null;
          inking.current = null;
        }}
        onUp={(c) => {
          if (erasing.current) {
            erasing.current = false;
            return;
          }
          if (inking.current) {
            inking.current = null;
            return;
          }
          if (drawing.current) {
            drawing.current.liftedAt = performance.now();
            drawing.current = null;
            runLaser();
            return;
          }
          const d = downAt.current;
          downAt.current = null;
          if (!d || Math.hypot(c.event.clientX - d.x, c.event.clientY - d.y) > 8) return;
          // Tapping a shown tape peels it back (or sticks it down again), as in XNotes.
          for (let i = doc.items.length - 1; i >= 0; i--) {
            const it = doc.items[i];
            if (it.kind !== "tape" || stageOf(it) > limit || !hitItem(it, c.x, c.y, 0)) continue;
            setPeeled((s) => {
              const n = new Set(s);
              if (!n.delete(it)) n.add(it);
              return n;
            });
            return;
          }
          // Tap the left quarter to go back, anywhere else to go forward.
          const r = c.event.currentTarget.getBoundingClientRect();
          if (c.event.clientX - r.left < r.width / 4) prev();
          else next();
        }}
        cursor={tool !== "tap" ? "crosshair" : hudVisible ? "default" : "none"}
        options={{
          paper,
          visible: (it) => stageOf(it) <= limit,
          peeled: (it) => peeled.has(it),
          reveal: (it) => {
            const r = revealing.current;
            const s = r?.sched.get(it);
            if (!r || !s) return undefined;
            const p = Math.min(1, Math.max(0, (performance.now() - r.start - s[0]) / Math.max(1, s[1] - s[0])));
            return { style: animation.style, p, area: r.area };
          },
          overlay: (ctx, v) => {
            drawInk(ctx, ink.current);
            drawLasers(ctx, v, lasers.current, performance.now(), holdMs);
          },
        }}
      />
      {settingsOpen && (
        <SettingsPanel scope="present" onClose={() => setSettingsOpen(false)} animation={onAnimation ? animation : undefined} onAnimation={onAnimation} />
      )}
      {caption && <div className="caption">{caption}</div>}
      {message && <div className="toast" onClick={() => setMessage(null)}>{message}</div>}
      {rec === "countdown" && <div className="countdown" key={count}>{count}</div>}
      {rec === "paused" && (
        <button className="paused-badge" onClick={togglePause}>
          Paused · not recording. Tap to continue (K)
        </button>
      )}
      {recording && rec !== "countdown" && (
        <div className={"recbar" + (rec === "paused" ? " paused" : "")} onPointerDown={(e) => e.stopPropagation()}>
          <span className="dot" />
          <span className="time">{formatTime(recorder.current?.elapsed() ?? 0)}</span>
          <IconButton icon={rec === "paused" ? "record" : "pause"} onClick={togglePause} title={rec === "paused" ? "Continue recording (K)" : "Pause recording (K)"} />
          <IconButton icon="stop" onClick={stopRecording} title="Stop and save the video" />
        </div>
      )}
      <nav className={"hud" + (hudVisible || settingsOpen ? "" : " hidden")} onPointerDown={(e) => e.stopPropagation()}>
        {onExit && <IconButton icon="close" onClick={onExit} title={exitTitle} />}
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
        <IconButton icon="laser" active={tool === "laser"} onClick={() => pickTool("laser")} title="Laser: points, then fades (P)" />
        <IconButton icon="pen" active={tool === "pen"} onClick={() => pickTool("pen")} title="Pen: write on the notes (D)" />
        <IconButton icon="highlighter" active={tool === "highlighter"} onClick={() => pickTool("highlighter")} title="Highlighter (M)" />
        <IconButton icon="eraser" active={tool === "eraser"} onClick={() => pickTool("eraser")} title="Eraser: remove presenter marks (E)" />
        {(tool === "pen" || tool === "highlighter") && (
          <span className="swatches small">
            {(tool === "pen" ? PEN_COLORS : MARKER_COLORS).map((c) => (
              <button
                key={c}
                className={c === inkColors[tool] ? "on" : ""}
                style={{ background: c }}
                onClick={() => setInkColors((s) => ({ ...s, [tool]: c }))}
                aria-label={`Colour ${c}`}
              />
            ))}
          </span>
        )}
        {inkCount > 0 && <IconButton icon="trash" onClick={clearInk} title="Clear your writing (C) · undo last: ⌘/Ctrl+Z" />}
        <span className="sep" />
        <IconButton icon="fullscreen" onClick={toggleFullscreen} title="Full screen (F)" />
        {recordName && canRecord() && !recording && (
          <IconButton icon="record" className="rec" onClick={startRecording} disabled={rec === "mic"} title="Record a video with your voice" />
        )}
        <IconButton icon="gear" active={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} title="Settings" />
      </nav>
    </div>
  );
}
