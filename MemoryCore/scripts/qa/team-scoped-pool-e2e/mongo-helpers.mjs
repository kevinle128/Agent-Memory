/**
 * MongoDB helpers of the local check: an own mongod with a replica set on a fixed port and a
 * temporary data directory, read access to the metadata database, and the fixture and dump tools.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { CORE_ROOT, HERE, NODE22, PORTS, sleep, startProcess } from "./lib.mjs";

const requireFromCore = createRequire(path.join(CORE_ROOT, "package.json"));
export const MONGO_URI = `mongodb://127.0.0.1:${PORTS.mongo}/?directConnection=true`;

export async function startMongo(work) {
  const dbpath = path.join(work, "mongo-data");
  fs.mkdirSync(dbpath, { recursive: true });
  const mongod = process.env.MONGOD ?? "mongod";
  const entry = startProcess({
    name: "mongod",
    command: mongod,
    port: PORTS.mongo,
    args: ["--replSet", "rs0", "--port", String(PORTS.mongo), "--dbpath", dbpath, "--bind_ip", "127.0.0.1", "--noauth"],
    logFile: path.join(work, "mongod.log"),
  });
  const { MongoClient } = requireFromCore("mongodb");
  const deadline = Date.now() + 60000;
  let client;
  while (Date.now() < deadline) {
    try {
      client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500 });
      await client.connect();
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!client) throw new Error("mongod did not start");
  try {
    await client.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${PORTS.mongo}` }] } });
  } catch (e) {
    if (!/already initialized/i.test(String(e.message))) throw e;
  }
  const primaryDeadline = Date.now() + 60000;
  while (Date.now() < primaryDeadline) {
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    await sleep(500);
  }
  await client.close();
  return entry;
}

/** Metadata database of one run: the database name is `<prefix>_default`. */
export async function openMongoDb(prefix) {
  const { MongoClient } = requireFromCore("mongodb");
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  return { client, db: client.db(`${prefix}_default`) };
}

function runTool(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exit ${code}: ${out.slice(-600)}`))));
  });
}

/** Builds the old-shape fixture with the old Core tree, into the Mongo database `<prefix>_default`. */
export function buildMongoFixture({ oldCoreRoot, outDir, prefix }) {
  return runTool(NODE22, ["--import", "tsx", path.join(HERE, "build-fixture.ts")], {
    CORE_ROOT: oldCoreRoot,
    OUT_DIR: outDir,
    MONGO_URI,
    MONGO_DB_PREFIX: prefix,
  });
}

export const dumpDb = (archive, prefix) => runTool("mongodump", ["--uri", MONGO_URI, "--db", `${prefix}_default`, `--archive=${archive}`]);
export const restoreDb = (archive, fromPrefix, toPrefix) =>
  runTool("mongorestore", ["--uri", MONGO_URI, `--archive=${archive}`, "--nsFrom", `${fromPrefix}_default.*`, "--nsTo", `${toPrefix}_default.*`]);
