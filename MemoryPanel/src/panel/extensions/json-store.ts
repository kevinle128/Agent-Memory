import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionStoragePort, JsonDocument } from './types.js';

const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * JSON documents under one folder. Nothing is created until the first write, so an extension that
 * never writes leaves no trace. An unreadable file is never overwritten.
 */
export function createJsonStorage(dir: string): ExtensionStoragePort {
  // One state per file name: two opens of the same name share the in-memory copy and the write queue,
  // so they cannot overwrite each other's updates.
  const documents = new Map<string, JsonDocument<{ version: 1 }>>();
  return {
    json<T extends { version: 1 }>(name: string, initial: T): JsonDocument<T> {
      if (!NAME_PATTERN.test(name)) throw new Error(`invalid extension data file name: ${name}`);
      const known = documents.get(name);
      if (known) return known as JsonDocument<T>;
      const path = join(dir, `${name}.json`);
      let current: T = initial;
      if (existsSync(path)) {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as T;
          if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) throw new Error('bad version');
          current = parsed;
        } catch {
          throw new Error(`unreadable extension data file: ${name}.json`);
        }
      }
      // Updates run one after another so two writers never read the same state.
      let queue: Promise<unknown> = Promise.resolve();
      const document: JsonDocument<T> = {
        read: () => current,
        update(mutate) {
          const run = queue.then(() => {
            const next = mutate(current);
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${path}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
            renameSync(tmp, path);
            current = next;
            return next;
          });
          queue = run.catch(() => undefined);
          return run;
        },
      };
      documents.set(name, document);
      return document;
    },
  };
}
