/**
 * Starts one Core gateway for the local check, on a fixed port with its own data directory.
 *
 *   CORE_ROOT=<MemoryCore dir> E2E_CORE_PORT=<port> E2E_DATA_DIR=<dir> E2E_GATEWAY_KEY=<key> \
 *     node --import <redirect-fetch.mjs> --import tsx core-launcher.ts
 *
 * The metadata database is `<E2E_DATA_DIR>/metadata/tdai_metadata_default/metadata.db`, or the Mongo database
 * `<TDAI_METADATA_MONGO_DB_PREFIX>_default` when `TDAI_METADATA_MONGO_URI` is set. The LLM
 * settings are placeholders: the check never reaches the extraction pipeline.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.CORE_ROOT;
const port = Number(process.env.E2E_CORE_PORT);
const dataDir = process.env.E2E_DATA_DIR;
const apiKey = process.env.E2E_GATEWAY_KEY;
if (!root || !port || !dataDir || !apiKey) throw new Error("CORE_ROOT, E2E_CORE_PORT, E2E_DATA_DIR and E2E_GATEWAY_KEY are required");

// With a Mongo URI the metadata lives in Mongo; Core refuses both settings at once.
if (!process.env.TDAI_METADATA_MONGO_URI) process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(dataDir, "metadata");
const { TdaiGateway } = await import(pathToFileURL(path.join(root, "src/gateway/server.ts")).href);

const gateway = new TdaiGateway({
  server: { port, host: "127.0.0.1", apiKey },
  data: { baseDir: dataDir },
  llm: { baseUrl: "http://127.0.0.1:1", apiKey: "placeholder", model: "placeholder" },
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await gateway.stop(); } catch { /* the process ends anyway */ }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await gateway.start();
console.log(`GATEWAY_READY port=${port} pid=${process.pid}`);
