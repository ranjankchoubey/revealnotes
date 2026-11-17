// Production build: bundle, copy public/, stamp the service worker, add PWA links.
import { cp, readFile, rm, writeFile } from "node:fs/promises";

const out = "dist";
await rm(out, { recursive: true, force: true });

const res = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: out,
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!res.success) {
  for (const log of res.logs) console.error(log);
  process.exit(1);
}

await cp("public", out, { recursive: true });

const sw = await readFile(`${out}/sw.js`, "utf8");
await writeFile(`${out}/sw.js`, sw.replace("__VERSION__", Date.now().toString(36)));

const links = [
  '<link rel="manifest" href="./manifest.webmanifest" />',
  '<link rel="icon" href="./icon.svg" type="image/svg+xml" />',
  '<link rel="apple-touch-icon" href="./apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
].join("");
const html = await readFile(`${out}/index.html`, "utf8");
await writeFile(`${out}/index.html`, html.replace("</head>", `${links}</head>`));

for (const o of res.outputs) console.log(`  ${o.path.replace(process.cwd() + "/", "")}  ${(o.size / 1024).toFixed(1)} KB`);
console.log("Built dist/");
