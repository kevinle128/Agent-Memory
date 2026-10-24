/**
 * SkillToolsV2 — 给 Review Agent 的工具集（绑定到 SkillCore）
 *
 * 暴露 4 个写动作 + 2 个读动作，覆盖 SkillExtractor 的需要：
 *   - skill_list      列出团队内可见 skill
 *   - skill_view      查看单个 skill 详情
 *   - skill_create    新建 skill
 *   - skill_update    全量替换 SKILL.md
 *   - skill_patch     单点串替
 *   - skill_files_write  增/改资源
 *
 * 不暴露 delete / files_remove —— 抽取流程不应能销毁团队 skill。
 * 工具错误以 JSON.stringify({error}) 返回，让 LLM 能 self-correct。
 *
 * 每次成功的写操作都 push 一条 ExtractedSkillCandidate 到 auditSink，
 * SkillExtractor 把它作为 candidates 返回给调用方。
 */

import { tool, jsonSchema } from "ai";
import { SkillApprovalRequiredError, SkillCoreError, type SkillCore } from "./skill-core.js";
import type { ChangePlacement } from "./skill-change-service.js";
import { isVisibleToProject, listVisibleSkills, searchVisibleSkills } from "./skill-project-view.js";

export type ExtractedAction =
  | "create"
  | "update"
  | "patch"
  | "files_write";

export interface ExtractedSkillCandidate {
  action: ExtractedAction;
  name: string;
  skill_id?: string;
  version?: number;
  description?: string;
}

export interface CreateSkillToolsOptions {
  core: SkillCore;
  /** 调用方身份（owner 校验依据）。 */
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  /** Session the conversation came from. Stored on every version the tools write. */
  source_session_id?: string;
  /**
   * Project of the conversation. Set by the caller from the verified project;
   * the model cannot set it. In `code` mode a create without a valid project is refused by Core.
   */
  project?: Pick<ChangePlacement, "project_key" | "project_hash" | "project_name">;
  auditSink: ExtractedSkillCandidate[];
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/** Shared tool parameters: every write says why and what it brings. */
const CHANGE_NOTE_PROPERTIES = {
  change_reason: {
    type: "string",
    description:
      "Why this change is made, in one or two sentences. Required for every write.",
  },
  change_summary: {
    type: "array",
    items: { type: "string" },
    maxItems: 5,
    description:
      "1-5 short items that tell a reviewer what the change adds, fixes or removes compared to the previous version.",
  },
} as const;

interface ChangeNote {
  change_reason?: string;
  change_summary?: string[];
}

/**
 * Last path segment of a project name, as a skill name part: lowercase ASCII
 * letters, digits and hyphens. `vtc/3q-chess/3q-game-api` gives `3q-game-api`.
 */
export function shortRepoName(projectName: string | undefined): string {
  const last = (projectName ?? "").split("/").filter(Boolean).pop() ?? "";
  return last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function jsonError(e: unknown): string {
  if (e instanceof SkillCoreError) {
    return JSON.stringify({ error: e.code, message: e.message });
  }
  return JSON.stringify({ error: "INTERNAL", message: (e as Error).message });
}

export function createSkillTools(opts: CreateSkillToolsOptions) {
  const { core, user_id, team_id, agent_id, task_id, auditSink, logger } = opts;
  // Everything the tools write is a change of the extractor: the approval policy
  // treats it as a proposal of the system, never as a person's edit.
  const note = (n: ChangeNote) => ({
    change_source: "extracted" as const,
    change_reason: n.change_reason,
    change_summary: n.change_summary,
    source_session_id: opts.source_session_id,
  });
  /** A change on a global skill becomes a proposal. Tell the model, so it does not retry. */
  const proposedJson = (e: unknown): string | undefined =>
    e instanceof SkillApprovalRequiredError
      ? JSON.stringify({
          ok: true,
          proposed: true,
          proposal_id: e.proposal.proposal_id,
          message: "This skill is global. Your change waits for a person to approve it; it is not applied yet.",
        })
      : undefined;
  // Read 路径：不带 task_id — audit 字段不参与检索。skill-core.ts:list/search
  // 内部已经再兜底 undefine 掉 task_id, 但工具层依然显式区分以让意图清晰、
  // 并防止未来 core 侧回退时又把 bug 引回来。
  // Write 路径：带 task_id 落审计列 (记 skill 首次落库时的对话上下文)。
  const readIds = { user_id, team_id, agent_id };
  const writeIds = { user_id, team_id, agent_id, task_id };
  // With a project the model sees global skills and skills of that project only.
  const projectHash = opts.project?.project_hash || undefined;
  /** Refuse a skill of another project, for reads and for writes. */
  const assertVisible = async (skill_id: string): Promise<void> => {
    if (!projectHash) return;
    const head = await core.get({ ...readIds, skill_id });
    if (!isVisibleToProject(head, projectHash)) {
      throw new SkillCoreError("SKILL_NOT_FOUND", "skill belongs to another project");
    }
  };
  /** The name is used in another scope or project: ask for a project-prefixed name. */
  const nameConflictJson = (e: unknown, name: string): string | undefined => {
    if (!(e instanceof SkillCoreError) || e.code !== "SKILL_NAME_SCOPE_CONFLICT") return undefined;
    const repo = shortRepoName(opts.project?.project_name);
    const example = repo ? `"${repo}-${name}"` : "a name that starts with the short repository name";
    return JSON.stringify({
      error: e.code,
      message:
        `The name "${name}" is used by a skill of another scope or project. ` +
        `Call skill_create again with a project-prefixed name, for example ${example}. ` +
        "The frontmatter `name` must change to the same value.",
    });
  };

  return {
    skill_list: tool({
      description:
        "List or search your agent's skills. Use this FIRST to see what already exists. "
        + "Pass `query` to rank results by keyword/semantic relevance; omit `query` to browse "
        + "the most-recently-updated skills.",
      inputSchema: jsonSchema<{ query?: string; top_k?: number }>({
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional. When set, ranks skills by relevance to this query using BM25 "
              + "keyword search over name + description + content (Chinese tokenized with jieba); "
              + "hybrid embedding retrieval is planned but not yet enabled — same field, will "
              + "transparently upgrade. Write 2-5 relevant keywords for best recall. "
              + "When omitted, returns the most-recently-updated skills ordered by updated_at DESC.",
          },
          top_k: { type: "number", description: "Max results (default 10)" },
        },
      }),
      execute: async ({ query, top_k }) => {
        try {
          if (query && query.trim()) {
            const hits = projectHash
              ? await searchVisibleSkills(core, readIds, projectHash, query, top_k ?? 10)
              : await core.search({ ...readIds, query, top_k });
            return JSON.stringify(hits.map((h) => ({
              skill_id: h.skill.skill_id, name: h.skill.name, description: h.skill.description,
              version: h.skill.version, score: h.score,
            })));
          }
          const r = projectHash
            ? await listVisibleSkills(core, readIds, projectHash, top_k ?? 50)
            : await core.list({ ...readIds, pagination: { limit: top_k ?? 50, offset: 0 } });
          return JSON.stringify(r.items.map((s) => ({
            skill_id: s.skill_id, name: s.name, description: s.description, version: s.version,
          })));
        } catch (e) { return jsonError(e); }
      },
    }),

    skill_view: tool({
      description: "Read a skill's full SKILL.md and resource manifest.",
      inputSchema: jsonSchema<{ skill_id: string; version?: number }>({
        type: "object",
        properties: {
          skill_id: { type: "string" },
          version: { type: "number", description: "Optional historical version (default head)" },
        },
        required: ["skill_id"],
      }),
      execute: async ({ skill_id, version }) => {
        try {
          await assertVisible(skill_id);
          const r = await core.get({ ...readIds, skill_id, version });
          return JSON.stringify({
            skill_id: r.skill_id, version: r.version, name: r.name, description: r.description,
            content: r.content, manifest: r.manifest,
          });
        } catch (e) { return jsonError(e); }
      },
    }),

    skill_create: tool({
      description: "Create a new skill. The frontmatter `name` MUST equal the `name` parameter.",
      inputSchema: jsonSchema<{ name: string; content: string } & ChangeNote>({
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name (lowercase letters/digits/hyphen)" },
          content: { type: "string", description: "Full SKILL.md text including frontmatter" },
          ...CHANGE_NOTE_PROPERTIES,
        },
        required: ["name", "content", "change_reason", "change_summary"],
      }),
      execute: async ({ name, content, ...n }) => {
        try {
          const r = await core.create({
            ...writeIds, name, content, ...note(n),
            // A conversation with a verified project makes a project skill.
            ...(opts.project?.project_hash ? { scope: "project" as const, ...opts.project } : {}),
          });
          auditSink.push({ action: "create", name, skill_id: r.skill_id, version: r.version, description: r.description });
          logger?.info(`[skill-tools] created ${r.skill_id}`);
          return JSON.stringify({ ok: true, skill_id: r.skill_id, version: r.version });
        } catch (e) { return nameConflictJson(e, name) ?? jsonError(e); }
      },
    }),

    skill_update: tool({
      description: "Replace the entire SKILL.md of an existing skill (you must own it).",
      inputSchema: jsonSchema<{ skill_id: string; content: string; expected_version: number } & ChangeNote>({
        type: "object",
        properties: {
          skill_id: { type: "string" },
          content: { type: "string", description: "New full SKILL.md text" },
          ...CHANGE_NOTE_PROPERTIES,
          expected_version: { type: "number", description: "Required optimistic lock — the version you just read (skill_list/skill_view). After a successful write use the returned version for the next edit." },
        },
        required: ["skill_id", "content", "expected_version", "change_reason", "change_summary"],
      }),
      execute: async ({ skill_id, content, expected_version, ...n }) => {
        try {
          await assertVisible(skill_id);
          const r = await core.update({ ...writeIds, skill_id, content, expected_version, ...note(n) });
          auditSink.push({ action: "update", name: r.name, skill_id, version: r.version });
          return JSON.stringify({ ok: true, version: r.version });
        } catch (e) { return proposedJson(e) ?? jsonError(e); }
      },
    }),

    skill_patch: tool({
      description: "Replace a unique substring in the SKILL.md. If old_string occurs >1 times you must pass replace_all.",
      inputSchema: jsonSchema<{
        skill_id: string; old_string: string; new_string: string;
        replace_all?: boolean; expected_version: number;
      } & ChangeNote>({
        type: "object",
        properties: {
          skill_id: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", description: "Default false" },
          ...CHANGE_NOTE_PROPERTIES,
          expected_version: { type: "number", description: "Required optimistic lock — the version you just read (skill_list/skill_view). After a successful write use the returned version for the next edit." },
        },
        required: ["skill_id", "old_string", "new_string", "expected_version", "change_reason", "change_summary"],
      }),
      execute: async ({ skill_id, old_string, new_string, replace_all, expected_version, ...n }) => {
        try {
          await assertVisible(skill_id);
          const r = await core.patch({ ...writeIds, skill_id, old_string, new_string, replace_all, expected_version, ...note(n) });
          auditSink.push({ action: "patch", name: r.name, skill_id, version: r.version });
          return JSON.stringify({ ok: true, version: r.version });
        } catch (e) { return proposedJson(e) ?? jsonError(e); }
      },
    }),

    skill_files_write: tool({
      description: "Write or overwrite a resource file in a skill's files/ directory.",
      inputSchema: jsonSchema<{
        skill_id: string; path: string; content: string;
        encoding?: "utf-8" | "base64"; mime_type?: string; is_executable?: boolean;
        expected_version: number;
      } & ChangeNote>({
        type: "object",
        properties: {
          skill_id: { type: "string" },
          path: { type: "string", description: "Relative path under files/, e.g. 'scripts/run.sh'" },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf-8", "base64"] },
          mime_type: { type: "string" },
          is_executable: { type: "boolean" },
          ...CHANGE_NOTE_PROPERTIES,
          expected_version: { type: "number", description: "Required optimistic lock — the version you just read (skill_list/skill_view). After a successful write use the returned version for the next edit." },
        },
        required: ["skill_id", "path", "content", "expected_version", "change_reason", "change_summary"],
      }),
      execute: async ({ skill_id, path, content, encoding, mime_type, is_executable, expected_version, ...n }) => {
        try {
          await assertVisible(skill_id);
          const r = await core.writeFiles({
            ...writeIds, skill_id, expected_version, ...note(n),
            files: [{ path, content, encoding: encoding ?? "utf-8", mime_type, is_executable }],
          });
          auditSink.push({ action: "files_write", name: r.name, skill_id, version: r.version });
          return JSON.stringify({ ok: true, version: r.version });
        } catch (e) { return proposedJson(e) ?? jsonError(e); }
      },
    }),
  };
}
