// Emit dist/proxies.json from the built registry. Runs after tsup so it can
// import the compiled ESM. The file is consumed by the gh-pages site, by
// jsDelivr, and by the SDK's own live-update self-source.
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

const { builtinProxies, historicalProxies } = await import(pathToFileURL(join(dist, "index.js")).href);

const payload = {
  generatedAt: new Date().toISOString(),
  live: builtinProxies.map((p) => ({
    id: p.id,
    label: p.label,
    endpoint: p.endpoint,
    caps: p.caps,
  })),
  historical: historicalProxies,
};

writeFileSync(join(dist, "proxies.json"), JSON.stringify(payload, null, 2));
console.log(`wrote dist/proxies.json: ${payload.live.length} live, ${payload.historical.length} historical`);
