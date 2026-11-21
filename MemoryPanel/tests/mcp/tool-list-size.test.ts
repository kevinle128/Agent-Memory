import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHarness, rpc, type McpHarness } from './support/meta-fixture.js';

/**
 * Every agent that attaches the server pays for the tool definitions in each request, and some
 * clients load all of them. This guards the size of the `tools/list` answer against silent growth.
 * Raise the limit only with a measured reason (`scripts/measure-mcp-tool-tokens.ts`).
 */
const MAX_TOOL_LIST_CHARS = 14_000;

let h: McpHarness;
beforeEach(async () => {
  h = await createMcpHarness();
});
afterEach(() => h.cleanup());

describe('tools/list size', () => {
  it('stays within the character budget', async () => {
    const key = h.world.addUser('ann');
    const res = await rpc(h.app, key, 'tools/list');
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(15);
    const size = JSON.stringify(body.result).length;
    console.info(`tools/list result: ${size} characters, ${body.result.tools.length} tools`);
    expect(size).toBeLessThanOrEqual(MAX_TOOL_LIST_CHARS);
  });
});
