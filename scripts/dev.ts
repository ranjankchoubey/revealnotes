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
  },
});
console.log(`RevealNotes dev server: ${server.url}`);
