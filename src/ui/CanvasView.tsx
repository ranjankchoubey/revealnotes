import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasDoc } from "../format/xcanvas";
import { render, type RenderOptions, type View } from "../render/draw";

export interface ContentPointer {
  x: number;
  y: number;
  /** Content px per CSS px (for hit tolerances). */
  scale: number;
  event: React.PointerEvent<HTMLCanvasElement>;
}

interface Props {
  doc: CanvasDoc;
  view: View | null;
  onView: (v: View) => void;
  /** Called with the CSS size whenever it changes (e.g. to fit the view). */
  onSize?: (w: number, h: number) => void;
  options: Omit<RenderOptions, "doc" | "view" | "width" | "height" | "onAsset">;
  /** When true, a primary-button drag pans instead of reaching the tool handlers. */
  panMode?: boolean;
  onDown?: (p: ContentPointer) => void;
  onMove?: (p: ContentPointer) => void;
  onUp?: (p: ContentPointer) => void;
  /** A tool gesture was interrupted (e.g. a second finger started a pinch). */
  onCancel?: () => void;
  onLeave?: () => void;
  cursor?: string;
  /** Pinch and ⌘/Ctrl+wheel stop zooming; panning still works (as XNotes' zoom lock). */
  zoomLocked?: boolean;
  className?: string;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 40;
export const ZOOM_STEP = 1.25;

export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  const cx = v.scrollX + sx / v.zoom;
  const cy = v.scrollY + sy / v.zoom;
  return { zoom, scrollX: cx - sx / zoom, scrollY: cy - sy / zoom };
}

export function CanvasView(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [assetTick, setAssetTick] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<"none" | "tool" | "pan" | "pinch">("none");
  const pinchStart = useRef<{ d: number; mx: number; my: number; view: View } | null>(null);
  const panLast = useRef<{ x: number; y: number } | null>(null);
  const spaceDown = useRef(false);
  const latest = useRef(p);
  latest.current = p;

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    // Measure now too: ResizeObserver only reports on a rendered frame, which a background tab may never give.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (size.w > 0 && size.h > 0) latest.current.onSize?.(size.w, size.h);
  }, [size.w, size.h]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) spaceDown.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !p.view || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.w * dpr);
    const H = Math.round(size.h * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext("2d")!;
    render(ctx, {
      ...p.options,
      doc: p.doc,
      view: p.view,
      width: size.w,
      height: size.h,
      onAsset: () => setAssetTick((t) => t + 1),
    });
  });
  void assetTick;

  // Wheel: needs a non-passive listener to prevent page zoom.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      const v = latest.current.view;
      if (!v) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      if (e.ctrlKey || e.metaKey) {
        if (latest.current.zoomLocked) return;
        // Trackpad pinches send small deltas; a mouse wheel notch can send hundreds, so cap each event.
        const d = Math.max(-50, Math.min(50, e.deltaY * unit));
        latest.current.onView(zoomAt(v, sx, sy, Math.exp(-d * 0.01)));
      } else {
        latest.current.onView({ ...v, scrollX: v.scrollX + (e.deltaX * unit) / v.zoom, scrollY: v.scrollY + (e.deltaY * unit) / v.zoom });
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const toContent = (e: React.PointerEvent<HTMLCanvasElement>): ContentPointer => {
    const v = p.view!;
    const r = e.currentTarget.getBoundingClientRect();
    return { x: v.scrollX + (e.clientX - r.left) / v.zoom, y: v.scrollY + (e.clientY - r.top) / v.zoom, scale: 1 / v.zoom, event: e };
  };

  const local = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startPinch = () => {
    const pts = [...pointers.current.values()];
    if (pts.length < 2 || !p.view) return;
    const [a, b] = pts;
    pinchStart.current = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: p.view };
  };

  return (
    <div ref={wrapRef} className={"canvas-wrap " + (p.className ?? "")}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: p.panMode ? "grab" : (p.cursor ?? "default") }}
        onPointerLeave={() => p.onLeave?.()}
        onPointerDown={(e) => {
          if (!p.view) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, local(e));
          if (pointers.current.size === 2) {
            if (gesture.current === "tool") p.onCancel?.();
            gesture.current = "pinch";
            startPinch();
            return;
          }
          if (pointers.current.size > 2) return;
          if (p.panMode || e.button === 1 || spaceDown.current) {
            gesture.current = "pan";
            panLast.current = local(e);
            return;
          }
          if (e.button !== 0) return;
          gesture.current = "tool";
          p.onDown?.(toContent(e));
        }}
        onPointerMove={(e) => {
          if (!p.view) return;
          if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, local(e));
          if (gesture.current === "pinch") {
            const s = pinchStart.current;
            const pts = [...pointers.current.values()];
            if (!s || pts.length < 2) return;
            const [a, b] = pts;
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const z = zoomAt(s.view, s.mx, s.my, p.zoomLocked ? 1 : d / Math.max(1, s.d));
            p.onView({ ...z, scrollX: z.scrollX - (mx - s.mx) / z.zoom, scrollY: z.scrollY - (my - s.my) / z.zoom });
          } else if (gesture.current === "pan") {
            const q = local(e);
            const last = panLast.current!;
            p.onView({ ...p.view, scrollX: p.view.scrollX - (q.x - last.x) / p.view.zoom, scrollY: p.view.scrollY - (q.y - last.y) / p.view.zoom });
            panLast.current = q;
          } else if (gesture.current === "tool") {
            p.onMove?.(toContent(e));
          } else if (e.pointerType === "mouse") {
            p.onMove?.(toContent(e));
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (gesture.current === "tool") p.onUp?.(toContent(e));
          if (gesture.current === "pinch" && pointers.current.size === 1) {
            // Lifting one finger of a pinch must not start a tool gesture.
            return;
          }
          if (pointers.current.size === 0) gesture.current = "none";
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (gesture.current === "tool") p.onCancel?.();
          if (pointers.current.size === 0) gesture.current = "none";
        }}
      />
    </div>
  );
}
