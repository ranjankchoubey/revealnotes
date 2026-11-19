import { useCallback, useEffect, useRef, useState } from "react";
import { isNoteFile, loadDocument, type CanvasDoc } from "./format/xcanvas";
import { attachPdf, pdfPictures } from "./format/pdf";
import { objectIds } from "./lesson/ids";
import {
  applyReveal, loadDraft, newLesson, pairingDoubt, parseReveal, preferredPaper, rememberPaper, saveDraft, serializeReveal, usedStages,
  type Lesson, type MatchReport, type Steps,
} from "./lesson/reveal";
import { openFiles, revealNameFor, saveReveal, type SaveHandle } from "./lesson/storage";
import { buildLessonHtml, downloadText } from "./lesson/export";
import { encodeView, toView } from "./lesson/viewdoc";
import type { PaperMode } from "./render/draw";
import { makeThumbnail } from "./render/thumb";
import { Editor, type SaveState } from "./ui/Editor";
import { Presenter } from "./ui/Presenter";
import { getSettings, presenterSettings, useSettings } from "./ui/settings";

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

type Applied = ReturnType<typeof applyReveal>;

/** A steps file that looks made for other notes, waiting for the user to say whether to use it. */
interface Doubt {
  applied: Applied;
  stepsName: string;
  madeFor: string;
  kept: number;
  total: number;
}

export function App() {
  const { watermark } = useSettings();
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
  const [doubt, setDoubt] = useState<Doubt | null>(null);
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
      if (doc.pdfBytes) {
        try {
          await attachPdf(doc);
        } catch {
          doc.warnings.push("The PDF pages could not be shown; your ink is drawn on plain paper.");
        }
      }
      const ids = objectIds(doc);
      let l = newLesson(ids);
      let msg: string | null = null;
      let newIds: string[] = [];
      let doubtful: Doubt | null = null;
      let file = revealText ? parseReveal(revealText) : null;
      if (file) {
        const res = applyReveal(doc, ids, file);
        const d = pairingDoubt(res.report, ids.length);
        if (d) {
          doubtful = { applied: res, stepsName: src.revealName ?? revealNameFor(file.document), madeFor: file.document, ...d };
          file = null;
        }
      }
      file ??= loadDraft(doc.manifestSha256, doc.fileName);
      if (file) {
        const res = applyReveal(doc, ids, file);
        l = res.lesson;
        if (res.report.docChanged) newIds = res.report.addedIds;
        msg = changeNotice(res.report) ?? (revealText && !doubtful ? null : usedStages(l.stages).length ? "Restored your steps from last time." : null);
      }
      setPending(null);
      setDoubt(doubtful);
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
      const doc = loaded.doc;
      const stages = usedStages(lesson.stages);
      const title = doc.fileName.replace(/\.(xcanvas|xnote)$/i, "");
      const html = await buildLessonHtml(
        {
          name: doc.fileName,
          view: encodeView(toView(doc, loaded.bytes, loaded.ids, lesson)),
          paper: lesson.paper,
          pdf: doc.pdf && doc.pdfBytes ? await pdfPictures(doc) : undefined,
          presenter: getSettings().embedPresenter ? presenterSettings() : undefined,
          watermark: getSettings().watermark.trim() || undefined,
        },
        {
          title,
          steps: stages.length,
          stepNames: stages.map((s) => lesson.names.get(s) ?? ""),
          pages: doc.pages?.length ?? null,
          exported: new Date().toISOString(),
          thumb: await makeThumbnail(doc, lesson.paper),
        },
      );
      const name = title + ".html";
      downloadText(name, html, "text/html");
      setNotice(`Downloaded ${name} — open it in any browser to present, even offline.`);
    } catch (e) {
      setNotice(`Could not export: ${e instanceof Error ? e.message : e}`);
    }
  }, [loaded, lesson]);

  const adoptSteps = (res: Applied, from: string) => {
    if (!lesson) return;
    edited.current = true;
    setFresh(new Set(res.report.docChanged ? res.report.addedIds : []));
    setHistory((h) => [...h, { stages: lesson.stages, names: lesson.names }]);
    setLesson(res.lesson);
    setSaveState("unsaved");
    setNotice(changeNotice(res.report) ?? `Loaded ${usedStages(res.lesson.stages).length} steps from ${from}.`);
  };

  const loadSteps = async (f: File) => {
    if (!loaded || !lesson) return;
    try {
      const file = parseReveal(await f.text());
      const res = applyReveal(loaded.doc, loaded.ids, file);
      const d = pairingDoubt(res.report, loaded.ids.length);
      if (d) setDoubt({ applied: res, stepsName: f.name, madeFor: file.document, ...d });
      else adoptSteps(res, f.name);
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
        recordName={loaded.doc.fileName.replace(/\.(xcanvas|xnote)$/i, "")}
        watermark={watermark}
      />
    );
  }

  if (loaded && lesson) {
    const sameName = doubt?.madeFor === loaded.doc.fileName;
    return (
      <>
        {doubt && (
          <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="doubt-title">
            <div className="modal">
              <h2 id="doubt-title">These steps may be for different notes</h2>
              <p>
                <b>{doubt.stepsName}</b> was saved for {sameName ? "a different version of " : ""}<b>{doubt.madeFor}</b>.
                Only {doubt.kept} of its {doubt.total} strokes match <b>{loaded.doc.fileName}</b>.
              </p>
              <p className="muted small">
                Picked the wrong file? Choose <i>Don’t use</i>, then load the right one with <i>Load steps file</i> in Settings.
              </p>
              <div className="actions">
                <button className="ghost" onClick={() => setDoubt(null)} autoFocus>Don’t use</button>
                <button
                  className="primary"
                  onClick={() => {
                    adoptSteps(doubt.applied, doubt.stepsName);
                    setDoubt(null);
                  }}
                >
                  Use anyway
                </button>
              </div>
            </div>
          </div>
        )}
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
          <li><span><b>Open</b> your <code>.xcanvas</code> or <code>.xnote</code></span></li>
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
