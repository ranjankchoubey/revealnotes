import { useCallback, useEffect, useRef, useState } from "react";
import { isNoteFile, loadDocument, type CanvasDoc } from "./format/xcanvas";
import { objectIds } from "./lesson/ids";
import {
  applyReveal, loadDraft, newLesson, parseReveal, preferredPaper, rememberPaper, saveDraft, serializeReveal, usedStages,
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
  const kept = r.matched + r.recovered;
  const parts = [`${kept} kept their step${r.recovered ? ` (${r.recovered} moved or touched up)` : ""}`];
  if (r.added) parts.push(`${r.added} new, outlined in orange, start in Always`);
  if (r.missing.length) parts.push(`${r.missing.length} erased`);
  return `Notes changed since the steps were saved: ${parts.join("; ")}.`;
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
  // Objects added or changed in the notes since the steps were saved; outlined until assigned.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const stepsInput = useRef<HTMLInputElement>(null);
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
      let newIds: string[] = [];
      const file = revealText ? parseReveal(revealText) : loadDraft(doc.manifestSha256, doc.fileName);
      if (file) {
        const res = applyReveal(doc, ids, file);
        l = res.lesson;
        if (res.report.docChanged) newIds = res.report.addedIds;
        msg = changeNotice(res.report) ?? (revealText || !usedStages(l.stages).length ? null : "Restored your steps from last time.");
      }
      setPending(null);
      setFresh(new Set(newIds));
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
    document.documentElement.dataset.theme = lesson?.paper ?? preferredPaper();
  }, [lesson?.paper]);

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

  const loadSteps = async (f: File) => {
    if (!loaded || !lesson) return;
    try {
      const res = applyReveal(loaded.doc, loaded.ids, parseReveal(await f.text()));
      edited.current = true;
      setFresh(new Set(res.report.docChanged ? res.report.addedIds : []));
      setHistory((h) => [...h, { stages: lesson.stages, names: lesson.names }]);
      setLesson(res.lesson);
      setSaveState("unsaved");
      setNotice(changeNotice(res.report) ?? `Loaded ${usedStages(res.lesson.stages).length} steps from ${f.name}.`);
    } catch (e) {
      setNotice(`Could not load steps: ${e instanceof Error ? e.message : e}`);
    }
  };

  const update = (next: Partial<Lesson>, record: boolean) => {
    if (!lesson) return;
    edited.current = true;
    if (record) setHistory((h) => [...h.slice(-99), { stages: lesson.stages, names: lesson.names }]);
    setSaveState("unsaved");
    setLesson({ ...lesson, ...next });
  };

  // Presenting is a history entry, so the Android back button (or browser Back) returns to editing.
  useEffect(() => {
    const onPop = () => setMode("edit");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const present = () => {
    window.history.pushState({ presenting: true }, "");
    setMode("present");
  };
  const exitPresent = () => {
    if ((window.history.state as { presenting?: boolean } | null)?.presenting) window.history.back();
    else setMode("edit");
  };

  if (loaded && lesson && mode === "present") {
    return (
      <Presenter
        doc={loaded.doc}
        ids={loaded.ids}
        steps={lesson}
        paper={lesson.paper}
        animation={lesson.animation}
        onAnimation={(animation) => update({ animation }, false)}
        onExit={exitPresent}
      />
    );
  }

  if (loaded && lesson) {
    return (
      <>
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
          onPaper={(paper: PaperMode) => {
            rememberPaper(paper);
            update({ paper }, false);
          }}
          onSave={save}
          onExport={exportHtml}
          onLoadSteps={() => stepsInput.current?.click()}
          onPresent={present}
          fresh={fresh}
          animation={lesson.animation}
          onAnimation={(animation) => update({ animation }, false)}
          onSeen={(seen) => {
            if (!seen.some((id) => fresh.has(id))) return;
            const next = new Set(fresh);
            for (const id of seen) next.delete(id);
            setFresh(next);
          }}
          onClose={() => {
            setLoaded(null);
            setLesson(null);
          }}
          onDismissNotice={() => setNotice(null)}
        />
        <input
          ref={stepsInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadSteps(f);
            e.target.value = "";
          }}
        />
      </>
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
            <p className="tip">
              <b>Already marked steps?</b> Select the notes file <i>and</i> its <code>.reveal.json</code> together (⌘/Ctrl-click),
              or drop both. On the same browser, just the notes file is enough.
            </p>
          </>
        )}
        <ol className="how">
          <li><span><b>Open</b> your <code>.xcanvas</code> (or <code>.xnote</code>, experimental)</span></li>
          <li><span><b>Mark steps</b>: tap or box your strokes</span></li>
          <li><span><b>Present</b>: reveal step by step</span></li>
        </ol>
        <p className="muted small">
          Your notes file is never changed. Steps are kept in this browser and saved as <code>name.reveal.json</code>.
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
