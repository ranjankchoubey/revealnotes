import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// Offline support and install only on the deployed (https) site, never in local dev.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  const hadController = !!navigator.serviceWorker.controller;
  // A new deploy took over: this page still runs the old code, so offer a reload.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || document.querySelector(".update-banner")) return;
    const b = document.createElement("button");
    b.className = "update-banner";
    b.textContent = "New version available. Tap to reload";
    b.onclick = () => location.reload();
    document.body.appendChild(b);
  });
  void navigator.serviceWorker.register("./sw.js").then(async (reg) => {
    void reg.update();
    const ready = await navigator.serviceWorker.ready;
    const urls = [location.href, ...performance.getEntriesByType("resource").map((e) => e.name)]
      .filter((u) => new URL(u).origin === location.origin);
    ready.active?.postMessage({ cache: urls });
  });
}
