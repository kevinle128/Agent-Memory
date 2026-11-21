/**
 * The `knowledge` tool group: 12 query tools for wikis and code graphs, and `knowledge_list`.
 *
 * Access rules:
 * - An id-addressed tool passes the Panel read gate for the caller of the request, then the
 *   caller must be an active member of the team of the asset. A `team_id` argument must name
 *   that same team.
 * - Whatever the reason for a refusal (unknown id, no right, another team, wrong asset type),
 *   the tool throws the same `NotReadableError`, so the answer does not tell which case it was.
 * - The gate runs before the other arguments are checked, so a bad argument never tells
 *   the caller that an id exists.
 * - A system admin has no override.
 */
import { ASSET_TYPE_CODE_GRAPH, ASSET_TYPE_WIKI, joinKnowledgeAssetsWithClient, type KnowledgeAssetMetaRaw, isActiveMetaAsset } from '../../http/routes/knowledge/common.js';
import { NotReadableError, type RequestAccess, type ScopeEntry } from '../access.js';
import type { McpToolDef, RegisteredTool } from '../registry.js';
import { MCP_TOOLS } from './knowledge-definitions.js';
import { NO_TEAM_MESSAGE } from './whoami.js';

export const MAX_RESULT_CHARS = 60_000;
export const CUT_NOTICE = `Output cut at ${MAX_RESULT_CHARS} characters. Narrow the query.`;
const MAX_ID_CHARS = 128;
/** Upper bounds that the copied schemas do not state. */
const MAX_WIKI_SEARCH_LIMIT = 100;
const MAX_CODE_FILES_DEPTH = 20;

type AssetKind = typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH;
type ToolResult = { text: string; isError: boolean };

interface PropertySchema {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: { type?: string };
}

function failure(text: string): ToolResult {
  return { text, isError: true };
}

function cut(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n${CUT_NOTICE}` : text;
}

/** Every result starts with the team, so an agent that reads rows of many teams can tell them apart. */
function withTeam(entry: ScopeEntry, body: string, isError = false): ToolResult {
  return { text: cut(`team: ${entry.team_name} (${entry.team_id})\n${body}`), isError };
}

function checkValue(name: string, value: unknown, schema: PropertySchema): string | null {
  const bad = (expected: string) => `Invalid argument ${name}: expected ${expected}.`;
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return bad('a string');
      if (schema.enum && !schema.enum.includes(value)) return bad(`one of ${schema.enum.join(', ')}`);
      return null;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
        return bad(schema.type === 'integer' ? 'an integer' : 'a number');
      }
      if (schema.minimum !== undefined && value < schema.minimum) return bad(`a value of at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return bad(`a value of at most ${schema.maximum}`);
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : bad('true or false');
    case 'array':
      if (!Array.isArray(value) || value.length === 0) return bad('a non-empty array');
      if (schema.items?.type === 'string' && !value.every((v) => typeof v === 'string' && v.trim())) {
        return bad('an array of non-empty strings');
      }
      return null;
    default:
      return null;
  }
}

/** Checks the arguments against the copied JSON schema. `team_id` and the id argument are handled elsewhere. */
function validateArgs(def: McpToolDef, args: Record<string, unknown>, skip: string): string | null {
  for (const [name, schema] of Object.entries(def.inputSchema.properties)) {
    if (name === skip) continue;
    const value = args[name];
    if (value === undefined || value === null) {
      if (def.inputSchema.required.includes(name)) return `Missing argument ${name}.`;
      continue;
    }
    if (typeof value === 'string' && !value.trim() && def.inputSchema.required.includes(name)) {
      return `Missing argument ${name}.`;
    }
    const problem = checkValue(name, value, schema as PropertySchema);
    if (problem) return problem;
  }
  return null;
}

/** The arguments that the knowledge service receives: those of the tool schema only, never `team_id`. */
function pickParams(def: McpToolDef, args: Record<string, unknown>, skip: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const name of Object.keys(def.inputSchema.properties)) {
    if (name !== skip && args[name] !== undefined && args[name] !== null) params[name] = args[name];
  }
  return params;
}

/**
 * Passes the gate for one id and returns the team of the asset, or throws `NotReadableError`.
 * Returns a failure result only for an id that is missing or of the wrong type: that tells nothing about any asset.
 */
async function gateAsset(
  access: RequestAccess,
  args: Record<string, unknown>,
  idName: string,
  kind: AssetKind,
  allowInFlightCodeOwner: boolean,
): Promise<{ id: string; entry: ScopeEntry } | ToolResult> {
  const id = args[idName];
  if (typeof id !== 'string' || !id.trim()) return failure(`Missing argument ${idName}.`);
  const refuse = () => new NotReadableError('asset', id);
  if (id.length > MAX_ID_CHARS) throw refuse();

  const check = await access.checkKnowledgeRead(id, { allowInFlightCodeOwner });
  if (!check.ok || !check.teamId) throw refuse();
  // Core refuses only archived assets. A deprecated or failed one is hidden from the list, so it is hidden here too.
  // The one exception is `code_status` for the owner, who needs it to see why a build failed.
  if (check.asset && !isActiveMetaAsset(check.asset.status)) {
    const ownerReadsStatus = allowInFlightCodeOwner && check.asset.owner_user_id === access.caller.userId;
    if (!ownerReadsStatus) throw refuse();
  }
  // A code graph that has no asset row yet is only reachable by its owner, and only as a code graph.
  const assetType = check.asset ? check.asset.asset_type : ASSET_TYPE_CODE_GRAPH;
  if (assetType !== kind) throw refuse();
  const teamArg = args.team_id;
  if (teamArg !== undefined && teamArg !== null && teamArg !== check.teamId) throw refuse();

  let scope: ScopeEntry[];
  try {
    scope = await access.scope(check.teamId);
  } catch (err) {
    // The team error would name the team of the asset.
    if (err instanceof NotReadableError) throw refuse();
    throw err;
  }
  const entry = scope[0];
  if (!entry) throw refuse();
  return { id, entry };
}

const isFailure = (v: unknown): v is ToolResult => typeof (v as ToolResult).isError === 'boolean';

function definition(name: string): Required<McpToolDef> {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Missing knowledge tool definition: ${name}`);
  return def;
}

function codeTool(name: string): RegisteredTool {
  const def = definition(name);
  const queryName = def.endpoint.split('/').pop() as string;
  return {
    ...def,
    group: 'knowledge',
    async run(args, access) {
      const gated = await gateAsset(access, args, 'code_graph_id', ASSET_TYPE_CODE_GRAPH, name === 'code_status');
      if (isFailure(gated)) return gated;
      const problem = validateArgs(def, args, 'code_graph_id');
      if (problem) return failure(problem);
      const params = pickParams(def, args, 'code_graph_id');
      if (name === 'code_files' && typeof params.maxDepth === 'number') {
        params.maxDepth = Math.min(params.maxDepth, MAX_CODE_FILES_DEPTH);
      }
      const result = await access
        .knowledge()
        .codeGraphQuery(gated.id, queryName, params, { returnToolErrors: true });
      return withTeam(gated.entry, result.text || '(empty result)', result.isError);
    },
  };
}

function wikiTool(
  name: string,
  call: (access: RequestAccess, id: string, args: Record<string, unknown>) => Promise<unknown>,
): RegisteredTool {
  const def = definition(name);
  return {
    ...def,
    group: 'knowledge',
    async run(args, access) {
      const gated = await gateAsset(access, args, 'wiki_id', ASSET_TYPE_WIKI, false);
      if (isFailure(gated)) return gated;
      const problem = validateArgs(def, args, 'wiki_id');
      if (problem) return failure(problem);
      const data = await call(access, gated.id, args);
      return withTeam(gated.entry, JSON.stringify(data, null, 2));
    },
  };
}

const KNOWLEDGE_TYPES = { wiki: ASSET_TYPE_WIKI, code_graph: ASSET_TYPE_CODE_GRAPH } as const;

const knowledgeListTool: RegisteredTool = {
  name: 'knowledge_list',
  group: 'knowledge',
  description: 'Lists the wikis and code graphs you can read. Call it first to get ids.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['wiki', 'code_graph'], description: 'Only wikis or only code graphs. Omit for both.' },
    },
    required: [],
  },
  async run(args, access) {
    const wanted = args.type;
    if (wanted !== undefined && wanted !== null && (typeof wanted !== 'string' || !(wanted in KNOWLEDGE_TYPES))) {
      return failure('Invalid argument type: expected one of wiki, code_graph.');
    }
    const kinds = (Object.keys(KNOWLEDGE_TYPES) as Array<keyof typeof KNOWLEDGE_TYPES>).filter(
      (k) => wanted === undefined || wanted === null || wanted === k,
    );
    const scope = await access.scope(args.team_id);
    if (scope.length === 0) return { items: [], message: NO_TEAM_MESSAGE };

    // One team at a time, so one call does not put many Core requests in flight.
    const items: unknown[] = [];
    for (const team of scope) {
      for (const kind of kinds) {
        // No visibility filter: Core returns what this caller may read, `restricted` and the caller's own `private` included.
        const assets = await access.coreList<KnowledgeAssetMetaRaw>('asset/list-accessible', {
          user_id: access.caller.userId,
          team_id: team.team_id,
          asset_type: KNOWLEDGE_TYPES[kind],
          action: 'read',
        });
        const active = assets.filter((a) => a.team_id === team.team_id && isActiveMetaAsset(a.status));
        const joined = await joinKnowledgeAssetsWithClient(access.knowledge(), active, KNOWLEDGE_TYPES[kind]);
        for (const row of joined) {
          items.push({
            team_id: team.team_id,
            team_name: team.team_name,
            knowledge_id: row.knowledge_id,
            type: kind,
            name: row.name,
            description: row.description ?? null,
            visibility: row.visibility,
            status: row.status,
            summary: row.summary ?? null,
            ...(kind === 'wiki'
              ? { page_count: row.page_count ?? null }
              : { repo_name: row.repo_name ?? null, branch: row.branch ?? null }),
          });
        }
      }
    }
    return { text: cut(JSON.stringify({ items, total: items.length }, null, 2)), isError: false };
  },
};

export const knowledgeTools: RegisteredTool[] = [
  knowledgeListTool,
  codeTool('code_search'),
  codeTool('code_explore'),
  codeTool('code_callers'),
  codeTool('code_callees'),
  codeTool('code_impact'),
  codeTool('code_node'),
  codeTool('code_status'),
  codeTool('code_files'),
  wikiTool('wiki_search', (access, id, args) => {
    const graph: { hop?: number; decay?: number; minScore?: number } = {};
    if (typeof args.hop === 'number') graph.hop = args.hop;
    if (typeof args.decay === 'number') graph.decay = args.decay;
    if (typeof args.minScore === 'number') graph.minScore = args.minScore;
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, MAX_WIKI_SEARCH_LIMIT) : undefined;
    return access.knowledge().wikiSearch(id, String(args.query), limit, graph);
  }),
  wikiTool('wiki_read', (access, id, args) => access.knowledge().wikiPageRead(id, args.refs as string[])),
  wikiTool('wiki_list', (access, id) => access.knowledge().wikiPageLs(id)),
  wikiTool('wiki_graph', (access, id) => access.knowledge().wikiGraph(id)),
];
