import { useEffect, useState } from "react";
import { loadXCanvas, type CanvasDoc } from "../format/xcanvas";
import { objectIds } from "../lesson/ids";
import { applyReveal, type Lesson } from "../lesson/reveal";
import { fromBase64, type EmbeddedLesson } from "../lesson/export";
import { Presenter } from "./Presenter";

/** Presentation-only view used by an exported lesson file. */
export function Player({ data }: { data: EmbeddedLesson }) {
  const [state, setState] = useState<{ doc: CanvasDoc; ids: string[]; lesson: Lesson } | { error: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const doc = await loadXCanvas(data.name, fromBase64(data.xcanvas));
        const ids = objectIds(doc);
        setState({ doc, ids, lesson: applyReveal(doc, ids, data.reveal).lesson });
      } catch (e) {
        setState({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [data]);

  if (!state) return null;
  if ("error" in state) return <main className="start"><p className="error">Could not open this lesson: {state.error}</p></main>;
  return (
    <Presenter
      doc={state.doc}
      ids={state.ids}
      steps={state.lesson}
      paper={data.reveal.paper === "dark" ? "dark" : "light"}
      animation={state.lesson.animation}
    />
  );
}
