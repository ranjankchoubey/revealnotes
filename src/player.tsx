import { createRoot } from "react-dom/client";
import { EMBED_ID, type EmbeddedLesson } from "./lesson/export";
import { Player } from "./ui/Player";
import "./styles.css";

// Entry for exported lesson files: presentation only, inlined into the HTML by buildLessonHtml.
const data = document.getElementById(EMBED_ID);
if (data) {
  const lesson = JSON.parse(data.textContent!) as EmbeddedLesson;
  document.documentElement.dataset.theme = lesson.reveal.paper === "dark" ? "dark" : "light";
  createRoot(document.getElementById("root")!).render(<Player data={lesson} />);
}
