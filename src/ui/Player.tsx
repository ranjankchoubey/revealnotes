import { useEffect, useState } from "react";
import { loadXCanvas, type CanvasDoc } from "../format/xcanvas";
import { objectIds } from "../lesson/ids";
import { applyReveal, type Lesson } from "../lesson/reveal";
import { fromBase64, type EmbeddedLesson } from "../lesson/export";
import { decodeView, fromView } from "../lesson/viewdoc";
import { pictureBackdrop } from "../format/pdf";
import type { PaperMode } from "../render/draw";
import { applyLessonSettings } from "./settings";
import { Presenter } from "./Presenter";

type Ready = { doc: CanvasDoc; ids: string[]; lesson: Lesson; paper: PaperMode };

async function open(data: EmbeddedLesson): Promise<Ready> {
  if (data.view) {
    const view = decodeView(data.view);
    return { ...fromView(data.name, view), paper: view.paper === "dark" ? "dark" : "light" };
  }
  // Older exports carry the notes file itself.
  if (!data.xcanvas || !data.reveal) throw new Error("the file has no notes in it.");
  const doc = await loadXCanvas(data.name, fromBase64(data.xcanvas));
  const ids = objectIds(doc);
  return { doc, ids, lesson: applyReveal(doc, ids, data.reveal).lesson, paper: data.reveal.paper === "dark" ? "dark" : "light" };
}

/** Presentation-only view used by an exported lesson file. */
export function Player({ data }: { data: EmbeddedLesson }) {
  const [state, setState] = useState<Ready | { error: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const ready = await open(data);
        if (data.pdf) ready.doc.pdf = pictureBackdrop(data.pdf);
        applyLessonSettings(data.presenter);
        setState(ready);
      } catch (e) {
        setState({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [data]);

  if (!state) return null;
  if ("error" in state) return <main className="start"><p className="error">Could not open this lesson: {state.error}</p></main>;
  // Opened from a notes site (same tab): offer the way back.
  const fromSite = !!document.referrer && window.history.length > 1;
  return (
    <Presenter
      doc={state.doc}
      ids={state.ids}
      steps={state.lesson}
      paper={state.paper}
      animation={state.lesson.animation}
      onExit={fromSite ? () => window.history.back() : undefined}
      exitTitle="Back to the notes (Esc)"
      watermark={data.watermark}
      watermarkLink
      startAt={1}
    />
  );
}
