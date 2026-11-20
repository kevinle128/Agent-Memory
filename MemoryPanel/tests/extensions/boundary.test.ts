import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const panelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendCore = join(panelRoot, 'src', 'panel');
const backendExtensions = join(panelRoot, 'src', 'extensions');
const webSrc = join(panelRoot, 'web', 'src');

const ALLOWED_CORE_IMPORTS = new Set(
  ['extensions/types.ts', 'auth/types.ts', 'auth/cookies.ts'].map((file) => join(backendCore, file)),
);
const CATALOG = join(backendCore, 'extensions', 'catalog.ts');

function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listSources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Relative module specifiers of static imports, re-exports and dynamic imports. */
function relativeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  const patterns = [/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g, /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /import\s*['"]([^'"]+)['"]/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].startsWith('.')) found.push(match[1]);
    }
  }
  return found;
}

/** The module file a specifier points at; `.js` stands for the `.ts` source. */
function resolveImport(from: string, specifier: string): string {
  return resolve(dirname(from), specifier).replace(/\.js$/, '.ts');
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

describe('extension boundary', () => {
  it('extension code imports only the allowed core files', () => {
    const offenders: string[] = [];
    for (const file of listSources(backendExtensions)) {
      for (const specifier of relativeImports(file)) {
        const target = resolveImport(file, specifier);
        if (inside(target, backendCore) && !ALLOWED_CORE_IMPORTS.has(target)) {
          offenders.push(`${relative(panelRoot, file)} -> ${relative(panelRoot, target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core code does not import extension code except the catalog', () => {
    const offenders: string[] = [];
    for (const file of listSources(backendCore)) {
      if (file === CATALOG) continue;
      for (const specifier of relativeImports(file)) {
        const target = resolveImport(file, specifier);
        if (inside(target, backendExtensions)) offenders.push(`${relative(panelRoot, file)} -> ${relative(panelRoot, target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('web extension code is only referenced by the web registry', () => {
    const webExtensions = join(webSrc, 'extensions', 'vtc');
    const registry = join(webSrc, 'extensions', 'registry.ts');
    const offenders: string[] = [];
    for (const file of listSources(webSrc)) {
      if (inside(file, webExtensions) || file === registry) continue;
      const text = readFileSync(file, 'utf8');
      const specifiers = [
        ...relativeImports(file).map((specifier) => resolveImport(file, specifier)),
        ...[...text.matchAll(/from\s*['"]@\/([^'"]+)['"]/g)].map((match) => join(webSrc, match[1])),
      ];
      if (specifiers.some((target) => inside(target, webExtensions))) offenders.push(relative(panelRoot, file));
    }
    expect(offenders).toEqual([]);
  });

  it('detects a forbidden import (scanner self-check)', () => {
    const fake = join(backendExtensions, 'vtc', 'x.ts');
    const target = resolveImport(fake, '../../panel/auth/service.js');
    expect(inside(target, backendCore) && !ALLOWED_CORE_IMPORTS.has(target)).toBe(true);
    const allowed = resolveImport(fake, '../../panel/extensions/types.js');
    expect(ALLOWED_CORE_IMPORTS.has(allowed)).toBe(true);
  });
});
