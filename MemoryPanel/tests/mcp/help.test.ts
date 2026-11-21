import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELP_TOPICS } from '../../src/panel/mcp/help/topics.js';
import { createMcpHarness, rpc, callTool, type McpHarness } from './support/meta-fixture.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
});
afterEach(() => h.cleanup());

describe('help topics', () => {
  it('has the five topics', () => {
    expect(HELP_TOPICS.map((t) => t.id)).toEqual([
      'overview',
      'memory-pipeline',
      'access',
      'knowledge',
      'glossary',
    ]);
  });

  it.each(HELP_TOPICS.map((t) => [t.id, t] as const))('%s is short, complete and cites its sources', (_id, topic) => {
    expect(topic.title).toBeTruthy();
    expect(topic.summary).toBeTruthy();
    const words = topic.text.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThan(400);
    expect(topic.text).toMatch(/Sources?: /);
  });

  it('cites repository files that exist', () => {
    if (!existsSync(resolve(REPO_ROOT, 'README.md'))) return;
    for (const topic of HELP_TOPICS) {
      const sources = topic.text.slice(topic.text.lastIndexOf('Source'));
      const paths = sources.match(/[A-Za-z][\w./-]*\.(?:md|ts)/g) ?? [];
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(resolve(REPO_ROOT, p)), `${topic.id}: ${p}`).toBe(true);
    }
  });

  it('the access topic states the tenancy rules', () => {
    const text = HELP_TOPICS.find((t) => t.id === 'access')!.text;
    for (const phrase of ['active member', 'A role in\n  team A gives nothing in team B', 'no extra access', 'No readable team']) {
      expect(text.replace(/\s+/g, ' ')).toContain(phrase.replace(/\s+/g, ' '));
    }
  });
});

describe('help tool and resources', () => {
  it('lists topics without an argument', async () => {
    const key = h.world.addUser('ann');
    const res = await callTool(h.app, key, 'help');
    expect(res.isError).toBe(false);
    for (const t of HELP_TOPICS) expect(res.text).toContain(`- ${t.id}: ${t.summary}`);
  });

  it('returns the text of a topic', async () => {
    const key = h.world.addUser('ann');
    const res = await callTool(h.app, key, 'help', { topic: 'glossary' });
    expect(res.text).toBe(HELP_TOPICS.find((t) => t.id === 'glossary')!.text);
  });

  it('returns the list and a notice for an unknown topic', async () => {
    const key = h.world.addUser('ann');
    const res = await callTool(h.app, key, 'help', { topic: 'nothing' });
    expect(res.text.startsWith('Unknown topic.')).toBe(true);
    expect(res.text).toContain('- access:');
  });

  it('serves each topic as a markdown resource', async () => {
    const key = h.world.addUser('ann');
    const list = (await (await rpc(h.app, key, 'resources/list')).json()) as {
      result: { resources: Array<{ uri: string; mimeType: string }> };
    };
    expect(list.result.resources.map((r) => r.uri)).toEqual(HELP_TOPICS.map((t) => `agent-memory://help/${t.id}`));
    expect(new Set(list.result.resources.map((r) => r.mimeType))).toEqual(new Set(['text/markdown']));
    const read = (await (await rpc(h.app, key, 'resources/read', { uri: 'agent-memory://help/overview' })).json()) as {
      result: { contents: Array<{ text: string }> };
    };
    expect(read.result.contents[0]!.text).toBe(HELP_TOPICS[0]!.text);
  });

  it('works for a user with no team', async () => {
    const key = h.world.addUser('lone');
    expect((await callTool(h.app, key, 'help', { topic: 'access' })).isError).toBe(false);
  });
});
