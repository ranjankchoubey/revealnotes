// Dev server: the app with hot reload, plus the standalone player bundle that Export inlines.
import index from "../index.html";

async function bundle(kind: "js" | "css"): Promise<Response> {
  const res = await Bun.build({ entrypoints: ["./src/player.tsx"], naming: "[name].[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  if (!res.success) return new Response(res.logs.join("\n"), { status: 500 });
  const out = res.outputs.find((o) => o.path.endsWith("." + kind));
  if (!out) return new Response("", { status: 404 });
  return new Response(out, { headers: { "Content-Type": kind === "js" ? "text/javascript" : "text/css" } });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  development: true,
  routes: {
    "/": index,
    "/player.js": () => bundle("js"),
    "/player.css": () => bundle("css"),
    // pdf.js, loaded at runtime only for notes with PDF pages.
    "/pdfjs/:file": (req) => {
      const file = req.params.file;
      if (file !== "pdf.min.mjs" && file !== "pdf.worker.min.mjs") return new Response("", { status: 404 });
      return new Response(Bun.file(`node_modules/pdfjs-dist/build/${file}`), { headers: { "Content-Type": "text/javascript" } });
    },
  },
});
console.log(`RevealNotes dev server: ${server.url}`);
