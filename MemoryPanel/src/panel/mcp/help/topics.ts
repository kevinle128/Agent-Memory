/**
 * Help text of the agent-memory MCP server. Kept as constants because `tsc` does not copy
 * Markdown files to `dist`. Each topic ends with the repository files it was written from.
 * Change the text together with those files.
 */
export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  text: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'overview',
    title: 'What Agent-Memory is',
    summary: 'What Agent-Memory stores and how this MCP server fits in.',
    text: `# What Agent-Memory is

Agent-Memory keeps what the next agent should not have to rediscover: project context,
preferences, decisions, reusable skills, and knowledge about documents and code.

Four kinds of memory asset exist:
- Chat Memory: preferences, facts, decisions and history taken from conversations.
- Skills: reusable procedures with versions, steps and checks.
- Wiki: documents turned into pages with a link graph.
- CodeGraph: code symbols, files, call relationships and impact paths.

A team owns the assets. A person is a member of one or more teams. Agents are workers of a team
and have their own memory and loadout.

This MCP server is read-only. It answers from the data of the teams you are an active member of.
It never changes data.

Start with:
- \`whoami\`: your user, your teams, your role in each team.
- \`help\` with a topic: \`memory-pipeline\`, \`access\`, \`knowledge\`, \`glossary\`.

Every tool accepts an optional \`team_id\`. Without it, a tool covers all your teams and labels
each row with its team.

Sources: README.md (What is TencentDB Agent Memory?), CONTEXT.md.`,
  },
  {
    id: 'memory-pipeline',
    title: 'How memory is built and recalled',
    summary: 'The L0-L3 layers, the recall budget and the agent loadout.',
    text: `# How memory is built and recalled

Conversations are saved first as L0 and refined by an asynchronous pipeline:

| Layer | Content | Use |
|---|---|---|
| L0 Conversation | Raw conversation with full context | Check exact words, times, sources |
| L1 Atom | Facts, preferences, constraints, events | Precise recall of actionable facts |
| L2 Scenario | Knowledge blocks per project or scenario | Restore a working context fast |
| L3 Core / Persona | Long-term profile and stable patterns | Enter the context of a user or team |

Generation and recall are layered. Normally L2 and L3 give a quick start. When a specific fact is
needed, retrieval (BM25, vectors, rank fusion) falls back to L1 and L0. The result is capped by
item count, character budget and timeout, so memory does not fill the context window.

Memory is not one global prompt. Chat Memory, Skills, Wiki and CodeGraph are registered as
memory assets. Fixed binding and access rules decide which assets an agent can use: first the
team, user, agent and visibility narrow the scope, then retrieval runs for the current query.

Memory is scoped by project. The proxy injects project memory only when a client hook has
reported the project. Without a known project, it injects only user-global memory that passed a
project filter. Wrong memory is worse than no memory, so the default is to inject nothing.

Knowledge is not injected as a whole. Agents call it on demand (see topic \`knowledge\`).

Sources: README.md (layers, loadout, knowledge on demand), docs/adr/0002-project-scoped-memory.md.`,
  },
  {
    id: 'access',
    title: 'What you can read, and why',
    summary: 'The access rules: per team, per role, per asset. No cross-team access.',
    text: `# What you can read, and why

You are identified by your user key. Access is checked for every call, from the live data of
the team. Nothing is cached between calls. If you are removed from a team, or your role changes,
the next call shows it.

Rules:
- Access is per team. You can read a team only when you are an active member of it. A role in
  team A gives nothing in team B.
- Roles: \`admin\`, \`member\`, \`reviewer\`. An admin has the \`team\` scope (what the team shares
  and what the team manages). A member or reviewer has the \`own\` scope (what the team shares and
  their own assets).
- A system administrator has no extra access here. Their scope is their own memberships, like
  every user. The same rule applies in the Panel UI.
- The owner of an asset can read it (while still an active member of the team).
- Everyone else needs the visibility to allow it:
  - \`private\`: only the owner. Team admins cannot read it.
  - \`team\` (and \`agent\`, \`task\`): every active member of the team can read it.
  - \`restricted\`: team admins, and members that an access rule names (by user, by team role or by agent).
- Members have read access only. This server has no write tool.

Errors do not reveal what exists. A team you cannot read and a team that does not exist give
the same answer: "No readable team with id ...". A wiki or code graph that is missing,
restricted, private to another person, or in another team gives: "No readable wiki or code
graph with id ...".

If \`whoami\` shows no teams, you are not an active member of any team and every tool returns
nothing. Ask a team admin to add you in the Agent-Memory Panel.

Sources: MemoryCore/src/metadata/service/permission-checker.ts, MemoryPanel/src/panel/mcp/access.ts.`,
  },
  {
    id: 'knowledge',
    title: 'Wiki and code graph knowledge',
    summary: 'How wiki pages and code graphs work and how agents use them.',
    text: `# Wiki and code graph knowledge

Documents and code become part of memory as searchable assets. They stay outside the context
until a tool reads them.

Wiki: product documents, design notes and runbooks organized as pages with a link graph. Search
for a page, read it, list the pages, and follow links in the graph.

CodeGraph: an index of a code base with files, symbols and call relationships. Search for a
symbol, explore the files that match a query, find callers and callees, and check what a
change may affect (impact) before you edit code.

Ids: a wiki has an id and a code graph has an id (\`cg-...\`). A tool that takes an id answers
only when you may read that asset (see topic \`access\`).

Tools: \`knowledge_list\` lists the wikis and code graphs that you can read, with their ids. The
wiki tools are \`wiki_search\`, \`wiki_read\`, \`wiki_list\` and \`wiki_graph\`. The code tools are
\`code_search\`, \`code_explore\`, \`code_callers\`, \`code_callees\`, \`code_impact\`, \`code_node\`,
\`code_status\` and \`code_files\`. Each result starts with the team of the asset.

Good practice:
1. Call \`whoami\` to see your teams.
2. Call \`knowledge_list\` to get the ids. Add \`team_id\` to look at one team only.
3. Search first, then read the pages or files that match. Do not read everything.
4. For code changes, check callers and impact before the edit.
5. A result over 60,000 characters is cut. Narrow the query.

Sources: README.md (a knowledge map that reads both docs and code, knowledge on demand),
MemoryCore/src/metadata/service/permission-checker.ts.`,
  },
  {
    id: 'glossary',
    title: 'Glossary',
    summary: 'Short definitions of the main Agent-Memory terms.',
    text: `# Glossary

- Member: a person who uses Memory Hub and signs in with a user key.
- Team: the group that owns memory assets. A person can be in several teams.
- Role: \`admin\`, \`member\` or \`reviewer\` in one team.
- Agent: a team-defined worker (for example Builder or Reviewer) with its own memory and loadout.
- Client type: the kind of coding agent that talks to the proxy, for example \`claude-code\` or \`codex\`.
- Memory asset: Chat Memory, Skill, Wiki or CodeGraph, registered with an owner, a team and a visibility.
- Visibility: \`private\` (owner only), \`team\` (all active members), \`restricted\` (access rules).
- Loadout: the set of assets that one agent may use.
- L0, L1, L2, L3: conversation, atom, scenario and persona layers of Chat Memory.
- Wiki: documents as pages with a link graph.
- CodeGraph: code symbols, files and call relationships.
- Scope: what you can read in a team. \`team\` for admins, \`own\` for members and reviewers.

Sources: CONTEXT.md, README.md.`,
  },
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((t) => t.id === id);
}
