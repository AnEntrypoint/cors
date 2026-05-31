// Build the static gh-pages site into ./site: an index.html listing every
// proxy plus a copy of proxies.json for jsDelivr/SDK consumption. Run after
// build so dist/proxies.json exists.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const site = join(root, "site");
mkdirSync(site, { recursive: true });

const data = JSON.parse(readFileSync(join(root, "dist", "proxies.json"), "utf8"));
copyFileSync(join(root, "dist", "proxies.json"), join(site, "proxies.json"));

const row = (p) =>
  `<tr><td><code>${esc(p.id)}</code></td><td><code>${esc(p.endpoint)}</code></td>` +
  `<td>${p.caps.methods.join(", ")}</td><td>${p.caps.body ? "yes" : "no"}</td>` +
  `<td>${p.caps.forwardsHeaders ? "yes" : "no"}</td><td>${p.caps.requiresKey ? "yes" : "no"}</td></tr>`;

const histRow = (h) => `<tr><td><code>${esc(h.id)}</code></td><td>${esc(h.note)}</td></tr>`;

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@anentrypoint/cors - public CORS proxy registry</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.6rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .meta { color: #666; font-size: 0.85rem; }
  a { color: #2a6; }
</style>
</head>
<body>
<h1>@anentrypoint/cors</h1>
<p>Pluggable fetch SDK over a registry of public CORS proxies. xstate-driven
perfect failover, floosie-piped live list updates, baked-in offline fallback.</p>
<p><a href="https://github.com/AnEntrypoint/cors">GitHub</a> -
<a href="https://www.npmjs.com/package/@anentrypoint/cors">npm</a> -
<a href="./proxies.json">proxies.json</a></p>
<p class="meta">Generated ${esc(data.generatedAt)} - ${data.live.length} live, ${data.historical.length} historical.</p>

<h2>Live proxies</h2>
<table>
<thead><tr><th>id</th><th>endpoint</th><th>methods</th><th>body</th><th>headers</th><th>key</th></tr></thead>
<tbody>${data.live.map(row).join("")}</tbody>
</table>

<h2>Historical / defunct / self-host-only</h2>
<table>
<thead><tr><th>id</th><th>note</th></tr></thead>
<tbody>${data.historical.map(histRow).join("")}</tbody>
</table>
</body>
</html>
`;

writeFileSync(join(site, "index.html"), html);
console.log(`wrote site/index.html and site/proxies.json (${data.live.length} live)`);
