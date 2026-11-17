import { useCallback, useEffect, useRef, useState } from "react";
import { isNoteFile, loadDocument, type CanvasDoc } from "./format/xcanvas";
import { objectIds } from "./lesson/ids";
import {
  applyReveal, loadDraft, newLesson, parseReveal, saveDraft, serializeReveal, usedStages,
  type Lesson, type MatchReport, type Steps,
} from "./lesson/reveal";
import { openFiles, revealNameFor, saveReveal, type SaveHandle } from "./lesson/storage";
import { buildLessonHtml, downloadText, toBase64 } from "./lesson/export";
import type { PaperMode } from "./render/draw";
import { Editor, type SaveState } from "./ui/Editor";
import { Presenter } from "./ui/Presenter";

interface Loaded {
  doc: CanvasDoc;
  ids: string[];
  bytes: Uint8Array;
}

const SHARE_CACHE = "revealnotes-share";

function changeNotice(r: MatchReport): string | null {
  if (!r.docChanged) return null;
  const parts = [`${r.matched} kept their step`];
  if (r.added) parts.push(`${r.added} new or edited set to Always`);
  if (r.missing.length) parts.push(`${r.missing.length} saved no longer match`);
  return `These notes changed since the steps were saved: ${parts.join(", ")}. Please check before presenting.`;
}

type LaunchWindow = Window & {
  launchQueue?: { setConsumer(cb: (p: { files: { getFile(): Promise<File> }[] }) => void): void };
};

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [history, setHistory] = useState<Steps[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveHandle, setSaveHandle] = useState<SaveHandle | null>(null);
  const [mode, setMode] = useState<"edit" | "present">("edit");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; document: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Only autosave after an edit in this tab: opening (or a stale second tab) must not overwrite a newer draft.
  const edited = useRef(false);

  const open = useCallback(async (files: FileList | File[]) => {
    setError(null);
    try {
      const src = await openFiles(files);
      if (!src.fileName) {
        const r = parseReveal(src.revealText!);
        setPending({ text: src.revealText!, document: r.document });
        return;
      }
      const revealText = src.revealText ?? pending?.text ?? null;
      const doc = await loadDocument(src.fileName, src.bytes);
      const ids = objectIds(doc);
      let l = newLesson(ids);
      let msg: string | null = null;
      const file = revealText ? parseReveal(revealText) : loadDraft(doc.manifestSha256);
      if (file) {
        const res = applyReveal(doc, ids, file);
        l = res.lesson;
        msg = changeNotice(res.report) ?? (revealText || !usedStages(l.stages).length ? null : "Restored your steps from last time.");
      }
      setPending(null);
      setLoaded({ doc, ids, bytes: src.bytes });
      edited.current = false;
      setLesson(l);
      setHistory([]);
      setSaveState("saved");
      setSaveHandle(null);
      setNotice(msg);
      setMode("edit");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [pending]);

  // Files from the OS ("Open with RevealNotes" on desktop) or the Android share sheet.
  useEffect(() => {
    (window as LaunchWindow).launchQueue?.setConsumer(async (p) => {
      if (p.files.length) void open(await Promise.all(p.files.map((f) => f.getFile())));
    });
    if (new URLSearchParams(location.search).has("shared") && "caches" in window) {
      void (async () => {
        const cache = await caches.open(SHARE_CACHE);
        const files: File[] = [];
        for (const req of await cache.keys()) {
          const res = await cache.match(req);
          if (res) files.push(new File([await res.blob()], decodeURIComponent(new URL(req.url).pathname.split("/").pop()!)));
          await cache.delete(req);
        }
        window.history.replaceState(null, "", location.pathname);
        if (files.length) void open(files);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loaded && lesson && edited.current) saveDraft(serializeReveal(loaded.doc, loaded.ids, lesson, true));
  }, [loaded, lesson]);

  const save = useCallback(async () => {
    if (!loaded || !lesson) return;
    const file = serializeReveal(loaded.doc, loaded.ids, lesson, true);
    setSaveState("saving");
    try {
      const res = await saveReveal(loaded.doc.fileName, JSON.stringify(file, null, 2) + "\n", saveHandle);
      setSaveHandle(res.handle);
      setLesson({ ...lesson, base: file });
      setSaveState("saved");
      setNotice(res.how === "file" ? `Saved to ${res.handle!.name}` : `Downloaded ${revealNameFor(loaded.doc.fileName)} — keep it next to your notes file.`);
    } catch (e) {
      setSaveState("unsaved");
      if (!(e instanceof DOMException && e.name === "AbortError")) setNotice(`Could not save: ${e instanceof Error ? e.message : e}`);
    }
  }, [loaded, lesson, saveHandle]);

  const exportHtml = useCallback(async () => {
    if (!loaded || !lesson) return;
    try {
      const html = await buildLessonHtml({
        name: loaded.doc.fileName,
        xcanvas: toBase64(loaded.bytes),
        reveal: serializeReveal(loaded.doc, loaded.ids, lesson, false),
      });
      const name = loaded.doc.fileName.replace(/\.(xcanvas|xnote)$/i, "") + ".html";
      downloadText(name, html, "text/html");
      setNotice(`Downloaded ${name} — open it in any browser to present, even offline.`);
    } catch (e) {
      setNotice(`Could not export: ${e instanceof Error ? e.message : e}`);
    }
  }, [loaded, lesson]);

  const update = (next: Partial<Lesson>, record: boolean) => {
    if (!lesson) return;
    edited.current = true;
    if (record) setHistory((h) => [...h.slice(-99), { stages: lesson.stages, names: lesson.names }]);
    setSaveState("unsaved");
    setLesson({ ...lesson, ...next });
  };

  if (loaded && lesson && mode === "present") {
    return <Presenter doc={loaded.doc} ids={loaded.ids} steps={lesson} paper={lesson.paper} onExit={() => setMode("edit")} />;
  }

  if (loaded && lesson) {
    return (
      <Editor
        doc={loaded.doc}
        ids={loaded.ids}
        steps={lesson}
        paper={lesson.paper}
        notice={notice}
        saveState={saveState}
        canUndo={history.length > 0}
        onSteps={(s, record) => update(s, record)}
        onUndo={() => {
          if (!history.length) return;
          update(history[history.length - 1], false);
          setHistory(history.slice(0, -1));
        }}
        onPaper={(paper: PaperMode) => update({ paper }, false)}
        onSave={save}
        onExport={exportHtml}
        onPresent={() => setMode("present")}
        onClose={() => {
          setLoaded(null);
          setLesson(null);
        }}
        onDismissNotice={() => setNotice(null)}
      />
    );
  }

  return (
    <main
      className={"start" + (dragOver ? " over" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void open(e.dataTransfer.files);
      }}
    >
      <div className="card">
        <h1>RevealNotes</h1>
        <p className="lead">Show your handwritten notes one step at a time.</p>
        {pending ? (
          <>
            <p className="pending">Steps loaded ✓ Now open <b>{pending.document}</b></p>
            <button className="primary big" onClick={() => fileInput.current?.click()}>Open {pending.document}</button>
            <p><button className="ghost small" onClick={() => setPending(null)}>Cancel</button></p>
          </>
        ) : (
          <>
            <button className="primary big" onClick={() => fileInput.current?.click()}>Open notes</button>
            <p className="muted">or drop your file here</p>
          </>
        )}
        <ol className="how">
          <li><span><b>Open</b> your <code>.xcanvas</code> (or <code>.xnote</code>, experimental)</span></li>
          <li><span><b>Mark steps</b>: tap or box your strokes</span></li>
          <li><span><b>Present</b>: reveal step by step</span></li>
        </ol>
        <p className="muted small">
          Your notes file is never changed. Steps are kept in this browser and saved as <code>name.reveal.json</code>.
          On another device, select the notes file and its <code>.reveal.json</code> together.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".xcanvas,.xnote,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files;
          if (f?.length && ([...f].some((x) => isNoteFile(x.name)) || [...f].some((x) => x.name.endsWith(".json")))) void open(f);
          e.target.value = "";
        }}
      />
    </main>
  );
}
