import { createRoot } from "react-dom/client";
import { EMBED_ID, type EmbeddedLesson } from "./lesson/export";
import { Player } from "./ui/Player";
import "./styles.css";

// Entry for exported lesson files: presentation only, inlined into the HTML by buildLessonHtml.
const data = document.getElementById(EMBED_ID);
if (data) {
  const lesson = JSON.parse(data.textContent!) as EmbeddedLesson;
  const paper = lesson.paper ?? lesson.reveal?.paper;
  document.documentElement.dataset.theme = paper === "dark" ? "dark" : "light";
  // View only: no context menu, save/print/view-source shortcuts or dragging pictures out (deters, can't prevent).
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.metaKey || e.ctrlKey) && ["s", "p", "u"].includes(e.key.toLowerCase())) e.preventDefault();
    },
    true,
  );
  createRoot(document.getElementById("root")!).render(<Player data={lesson} />);
}
