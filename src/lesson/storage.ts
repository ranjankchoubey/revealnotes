// Minimal File System Access typings (Chromium). Other browsers fall back to a download.
interface WritableLike {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}
export interface SaveHandle {
  name: string;
  createWritable(): Promise<WritableLike>;
}
type SaveWindow = Window & {
  showSaveFilePicker?: (o: {
    suggestedName: string;
    id?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<SaveHandle>;
};

export interface LessonSource {
  /** Empty when only a reveal .json was chosen. */
  fileName: string;
  bytes: Uint8Array;
  /** Text of a reveal .json opened alongside the document, if any. */
  revealText: string | null;
}

/** An .xcanvas and/or a reveal .json, from a picker, a drop, a share or an OS "open with". */
export async function openFiles(list: FileList | File[]): Promise<LessonSource> {
  const files = [...list];
  const xc = files.find((f) => /\.(xcanvas|xnote)$/i.test(f.name));
  const js = files.find((f) => f.name.toLowerCase().endsWith(".json"));
  if (!xc && !js) throw new Error("That isn't an XNotes file. Choose a .xcanvas or .xnote file.");
  return {
    fileName: xc?.name ?? "",
    bytes: xc ? new Uint8Array(await xc.arrayBuffer()) : new Uint8Array(),
    revealText: js ? await js.text() : null,
  };
}

export const revealNameFor = (docName: string) => docName.replace(/\.(xcanvas|xnote)$/i, "") + ".reveal.json";

/**
 * Write the reveal file. Chromium asks where once (next to the .xcanvas), then saves silently to the
 * same file; other browsers download it. Never touches the document itself.
 */
export async function saveReveal(docName: string, json: string, handle: SaveHandle | null): Promise<{ handle: SaveHandle | null; how: "file" | "download" }> {
  const w = window as SaveWindow;
  if (handle || w.showSaveFilePicker) {
    const h = handle ?? (await w.showSaveFilePicker!({
      suggestedName: revealNameFor(docName),
      id: "revealnotes",
      types: [{ description: "Reveal steps", accept: { "application/json": [".json"] } }],
    }));
    const out = await h.createWritable();
    await out.write(json);
    await out.close();
    return { handle: h, how: "file" };
  }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = revealNameFor(docName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { handle: null, how: "download" };
}
