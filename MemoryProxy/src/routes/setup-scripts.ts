/**
 * `GET /setup/hooks.sh` and `GET /setup/hook.sh` — serve the client hook scripts.
 *
 *   curl -fsSL <proxy-origin>/setup/hooks.sh | bash -s -- --base-url <ANTHROPIC_BASE_URL>
 *
 * `hooks.sh` is the installer; it downloads `hook.sh` from the same origin.
 * The scripts hold no secret, so the routes need no auth. They are read from
 * `MemoryProxy/assets/client-hooks/` on each request (a few KB), so a deploy
 * that changes them needs no restart logic.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Context } from "hono";

const SCRIPTS: Record<string, string> = {
  "hooks.sh": "install.sh",
  "hook.sh": "hook.sh",
};

function scriptPath(file: string): string {
  return fileURLToPath(new URL(`../../assets/client-hooks/${file}`, import.meta.url));
}

export function createSetupScriptHandler(name: keyof typeof SCRIPTS | string) {
  const file = SCRIPTS[name];
  return async (c: Context): Promise<Response> => {
    if (!file) return c.text("not found\n", 404);
    try {
      const body = await readFile(scriptPath(file), "utf-8");
      return c.body(body, 200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      });
    } catch {
      return c.text("script not available\n", 404);
    }
  };
}
