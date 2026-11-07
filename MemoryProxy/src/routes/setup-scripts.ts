/**
 * `GET /setup/hooks.sh`, `GET /setup/hook.sh` and `GET /setup/pi-extension.ts` — serve the client hook files.
 * `GET /:agent/:spaceId/v3/hook/manifest` — version and sha256 of the served `hook.sh`.
 *
 *   curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --base-url <ANTHROPIC_BASE_URL>
 *
 * `hooks.sh` is the installer; it downloads `hook.sh` from the same origin.
 * The scripts hold no secret, so the routes need no auth. They are read from
 * `MemoryProxy/assets/client-hooks/`.
 *
 * `hook.sh` is read once per process. The manifest and the download serve the
 * same bytes, so the sha256 in the manifest always matches the file that the
 * hook downloads when it updates itself. A deploy starts a new process, which
 * reads the new file.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Context } from "hono";

const SCRIPTS: Record<string, string> = {
  "hooks.sh": "install.sh",
  "hook.sh": "hook.sh",
  "pi-extension.ts": "pi-extension.ts",
};

const HOOK_VERSION_RE = /^HOOK_VERSION="([^"\n]+)"$/m;

function scriptPath(file: string): string {
  return fileURLToPath(new URL(`../../assets/client-hooks/${file}`, import.meta.url));
}

/** The served `hook.sh`: its bytes, the version it declares and the sha256 of the bytes. */
export interface HookAsset {
  body: Buffer;
  version: string;
  sha256: string;
}

let hookAsset: HookAsset | null = null;

/**
 * Read `hook.sh` once and keep it. Throws when the file is missing or has no
 * `HOOK_VERSION="..."` line, so a broken asset never gets a manifest.
 */
export function getHookAsset(): HookAsset {
  if (hookAsset) return hookAsset;
  const body = readFileSync(scriptPath("hook.sh"));
  const version = HOOK_VERSION_RE.exec(body.toString("utf-8"))?.[1];
  if (!version) throw new Error("hook.sh has no HOOK_VERSION line");
  hookAsset = { body, version, sha256: createHash("sha256").update(body).digest("hex") };
  return hookAsset;
}

export function createSetupScriptHandler(name: keyof typeof SCRIPTS | string) {
  const file = SCRIPTS[name];
  return async (c: Context): Promise<Response> => {
    if (!file) return c.text("not found\n", 404);
    try {
      const body = name === "hook.sh" ? new Uint8Array(getHookAsset().body) : await readFile(scriptPath(file), "utf-8");
      return c.body(body, 200, {
        "content-type": name === "pi-extension.ts" ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      });
    } catch {
      return c.text("script not available\n", 404);
    }
  };
}

/** `{version, sha256}` of the served `hook.sh`; 503 when the asset cannot be read. */
export function hookManifestHandler(c: Context): Response {
  try {
    const { version, sha256 } = getHookAsset();
    return c.json({ version, sha256 }, 200, { "cache-control": "no-store" });
  } catch (err) {
    console.warn("[setup-scripts] hook manifest unavailable:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "hook not available" }, 503);
  }
}
