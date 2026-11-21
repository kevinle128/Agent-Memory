/**
 * The question bank is a seed for the manual eval with a real agent. This test answers each
 * question by direct tool calls on a fixture world, as the persona, so a tool change that breaks
 * a question shows up here first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from '../../src/panel/mcp/registry.js';
import bank from './question-bank.json';
import { seedKnowledgeWorld } from './support/knowledge-world.js';
import { callTool, createMcpHarness, type McpHarness } from './support/meta-fixture.js';

interface BankEntry {
  id: string;
  persona: 'member' | 'non_technical' | 'admin';
  question: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  facts?: string[];
  /** Text that must not appear in any answer of the question. */
  absent?: string[];
  denied?: boolean;
}

const entries = bank as BankEntry[];

/** The user of the fixture world that plays each persona. */
const PERSONA_USER: Record<BankEntry['persona'], string> = {
  member: 'mia',
  non_technical: 'rev',
  admin: 'adm',
};

const NOT_READABLE = /^No readable (team|wiki or code graph) with id /;

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
  seedKnowledgeWorld(h);
});
afterEach(() => h.cleanup());

describe('question bank seed', () => {
  it('has at least 18 questions, 6 for each persona, with unique ids', () => {
    expect(entries.length).toBeGreaterThanOrEqual(18);
    for (const persona of Object.keys(PERSONA_USER)) {
      expect(entries.filter((e) => e.persona === persona).length, persona).toBeGreaterThanOrEqual(6);
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('gives each question calls of registered tools and either facts or a denial', () => {
    const tools = new Set(TOOL_REGISTRY.map((t) => t.name));
    for (const e of entries) {
      expect(e.question.length, e.id).toBeGreaterThan(10);
      expect(e.calls.length, e.id).toBeGreaterThan(0);
      for (const call of e.calls) expect(tools.has(call.tool), `${e.id}: ${call.tool}`).toBe(true);
      expect(Boolean(e.denied) !== Boolean(e.facts?.length), `${e.id} needs facts or denied, not both`).toBe(true);
    }
  });

  it('covers the denial cases, code tools included, and states what must not leak', () => {
    const denied = entries.filter((e) => e.denied);
    expect(denied.length).toBeGreaterThanOrEqual(4);
    expect(denied.some((e) => e.calls.some((c) => c.tool.startsWith('code_')))).toBe(true);
    for (const e of denied) expect(e.absent?.length, e.id).toBeGreaterThan(0);
  });

  for (const entry of entries) {
    it(`${entry.id}: ${entry.question}`, async () => {
      const key = h.world.keyOf(PERSONA_USER[entry.persona]);
      const outputs: string[] = [];
      for (const call of entry.calls) {
        const res = await callTool(h.app, key, call.tool, call.args);
        outputs.push(res.text);
        if (entry.denied) {
          expect(res.isError, `${call.tool}: ${res.text}`).toBe(true);
          expect(res.text).toMatch(NOT_READABLE);
        } else {
          expect(res.isError, `${call.tool}: ${res.text}`).toBe(false);
        }
      }
      const combined = outputs.join('\n');
      for (const fact of entry.facts ?? []) expect(combined, `fact: ${fact}`).toContain(fact);
      for (const text of entry.absent ?? []) expect(combined, `absent: ${text}`).not.toContain(text);
    });
  }
});
