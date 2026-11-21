/**
 * Measures what the tool definitions of the agent-memory MCP server cost in tokens.
 *
 * It lists the tools of a running server with the MCP SDK client, converts them to the Anthropic
 * `tools` format, and asks a `count_tokens` endpoint for the input size of one short message
 * with and without them. The key is read from a file and never printed.
 *
 * Usage:
 *   COUNT_TOKENS_URL=https://api.anthropic.com/v1/messages/count_tokens \
 *   COUNT_TOKENS_AUTH='x-api-key: <key>' \
 *   npx tsx scripts/measure-mcp-tool-tokens.ts --mcp-url http://127.0.0.1:8126/api/v1/mcp \
 *     --instance default --key-file ./user-key.txt [--model claude-sonnet-4-5]
 *
 * `COUNT_TOKENS_AUTH` is one header line, `Name: value`.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5';

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseAuthHeader(line: string): [string, string] {
  const at = line.indexOf(':');
  if (at <= 0) fail('COUNT_TOKENS_AUTH must be one header line: "Name: value".');
  return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}

async function listTools(mcpUrl: string, instance: string, userKey: string): Promise<AnthropicTool[]> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { 'x-tdai-service-id': instance, 'x-tdai-user-key': userKey } },
  });
  const client = new Client({ name: 'measure-mcp-tool-tokens', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Record<string, unknown>,
    }));
  } finally {
    await client.close();
  }
}

async function countTokens(
  url: string,
  authHeader: [string, string],
  model: string,
  tools: AnthropicTool[],
): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      [authHeader[0]]: authHeader[1],
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      ...(tools.length > 0 ? { tools } : {}),
    }),
  });
  if (!res.ok) fail(`count_tokens failed with HTTP ${res.status}.`);
  const body = (await res.json()) as { input_tokens?: number };
  if (typeof body.input_tokens !== 'number') fail('count_tokens answered without input_tokens.');
  return body.input_tokens;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'mcp-url': { type: 'string' },
      instance: { type: 'string', default: 'default' },
      'key-file': { type: 'string' },
      model: { type: 'string', default: DEFAULT_MODEL },
    },
  });
  const mcpUrl = values['mcp-url'];
  const keyFile = values['key-file'];
  const countUrl = process.env.COUNT_TOKENS_URL;
  const countAuth = process.env.COUNT_TOKENS_AUTH;
  if (!mcpUrl || !keyFile) fail('Give --mcp-url and --key-file.');
  if (!countUrl || !countAuth) fail('Set COUNT_TOKENS_URL and COUNT_TOKENS_AUTH.');

  const userKey = readFileSync(keyFile, 'utf8').trim();
  if (!userKey) fail('The key file is empty.');
  const authHeader = parseAuthHeader(countAuth);
  const model = values.model ?? DEFAULT_MODEL;

  const tools = await listTools(mcpUrl, values.instance ?? 'default', userKey);
  // One tool with an empty schema gives the fixed cost that the API adds for any `tools` list.
  const probe: AnthropicTool[] = [{ name: 'probe', description: '', input_schema: { type: 'object', properties: {} } }];

  const without = await countTokens(countUrl, authHeader, model, []);
  const withProbe = await countTokens(countUrl, authHeader, model, probe);
  const withAll = await countTokens(countUrl, authHeader, model, tools);

  console.log(`model: ${model}`);
  console.log(`tools listed: ${tools.length}`);
  console.log(`characters of the tool definitions: ${JSON.stringify(tools).length}`);
  console.log(`input tokens without tools: ${without}`);
  console.log(`input tokens with all tools: ${withAll}`);
  console.log(`tokens of all tool definitions (difference): ${withAll - without}`);
  console.log(`  of which the fixed cost of any tools list: ${withProbe - without}`);
  console.log(`  of which the definitions themselves: ${withAll - withProbe}`);
}

main().catch((err) => fail(`Measurement failed: ${err instanceof Error ? err.message : String(err)}`));
