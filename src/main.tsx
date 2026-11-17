import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EMBED_ID, type EmbeddedLesson } from "./lesson/export";
import { Player } from "./ui/Player";
import "./styles.css";

const embedded = document.getElementById(EMBED_ID);
const root = createRoot(document.getElementById("root")!);

if (embedded) {
  root.render(<Player data={JSON.parse(embedded.textContent!) as EmbeddedLesson} />);
} else {
  root.render(<App />);
  // Offline support and install only on the deployed (https) site, never in local dev.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    void navigator.serviceWorker.register("./sw.js").then(async () => {
      const reg = await navigator.serviceWorker.ready;
      const urls = [location.href, ...performance.getEntriesByType("resource").map((e) => e.name)]
        .filter((u) => new URL(u).origin === location.origin);
      reg.active?.postMessage({ cache: urls });
    });
  }
}
