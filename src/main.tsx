import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// Offline support and install only on the deployed (https) site, never in local dev.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  void navigator.serviceWorker.register("./sw.js").then(async () => {
    const reg = await navigator.serviceWorker.ready;
    const urls = [location.href, ...performance.getEntriesByType("resource").map((e) => e.name)]
      .filter((u) => new URL(u).origin === location.origin);
    reg.active?.postMessage({ cache: urls });
  });
}
