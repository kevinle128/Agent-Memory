/**
 * Shared ISkillStore contract suite.
 *
 * Backend-agnostic behavioral tests every ISkillStore must satisfy
 * (SqliteSkillStore, TcvdbSkillStore, MongoSkillStore). A concrete spec supplies
 * a harness that creates/disposes an isolated store for one backend.
 *
 * Scope (Phase-1 skill version-row surface):
 *   - lifecycle + capability shape
 *   - appendVersion create → getHead (v1)
 *   - appendVersion again → v2 head, v1 demoted, countVersions / listVersions DESC
 *   - listSkills returns head-only
 *   - searchSkills (BM25) recall by keyword
 *   - archiveHead soft-delete semantics (getHead vs getHeadIncludingArchived)
 *   - deleteAllVersions physical removal
 *
 * Skill `$search` (mongot) is eventually consistent → search assertions poll
 * when the harness sets `ftsEventuallyConsistent: true`.
 */
import { describe, it, expect } from "vitest";
import type { ISkillStore, SkillSearchResult } from "../skill-store.interface.js";
import type { AppendVersionInput } from "../types.js";
import type { SkillChangeProposal } from "../skill-proposal-types.js";

export interface SkillStoreContractHarness {
  backend: string;
  createStore(): Promise<ISkillStore>;
  disposeStore(store: ISkillStore): Promise<void>;
  ftsEventuallyConsistent?: boolean;
}

let seq = 0;
function makeInput(over: Partial<AppendVersionInput> = {}): AppendVersionInput {
  seq += 1;
  return {
    skill_id: over.skill_id ?? `sk-${Date.now()}-${seq}`,
    team_id: "team-a",
    owner_agent_id: "agent-a",
    user_id: "user-a",
    task_id: "task-a",
    name: over.name ?? `skill-${seq}`,
    description: over.description ?? "A contract-suite skill",
    content: over.content ?? "# Skill\nDo the thing.",
    content_hash: over.content_hash ?? `hash-${seq}`,
    manifest: over.manifest ?? [],
    storage_dir: over.storage_dir ?? "",
    ...over,
  };
}

function makeProposal(over: Partial<SkillChangeProposal> = {}): SkillChangeProposal {
  return {
    proposal_id: "prp-x",
    team_id: "team-a",
    owner_agent_id: "agent-a",
    skill_id: "sk-p",
    skill_name: "proposal-target",
    base_version: 1,
    proposed_content: "# Skill\nBetter.",
    proposed_description: "d",
    proposed_files: { write: [], remove: [] },
    change_reason: "why",
    change_summary: ["adds a"],
    source_session_id: "sess-1",
    created_by: "user-a",
    status: "pending",
    created_at_ms: 1000,
    decided_at_ms: 0,
    decided_by: "",
    result_version: 0,
    ...over,
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 400 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

export function runSkillStoreContract(harness: SkillStoreContractHarness): void {
  const { backend, ftsEventuallyConsistent } = harness;

  const searchExpect = async (
    run: () => Promise<SkillSearchResult[]>,
    want: (rows: SkillSearchResult[]) => boolean,
  ): Promise<SkillSearchResult[]> => (ftsEventuallyConsistent ? pollUntil(run, want) : run());

  describe(`ISkillStore contract [${backend}]`, () => {
    it("init → non-degraded + capability shape", async () => {
      const store = await harness.createStore();
      try {
        expect(store.isDegraded()).toBe(false);
        const caps = store.getCapabilities();
        expect(typeof caps.vectorSearch).toBe("boolean");
        expect(typeof caps.ftsSearch).toBe("boolean");
        expect(typeof caps.nativeHybridSearch).toBe("boolean");
        expect(typeof caps.sparseVectors).toBe("boolean");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("appendVersion create → getHead returns v1", async () => {
      const store = await harness.createStore();
      try {
        const input = makeInput({ skill_id: "sk-create", name: "create-me" });
        const created = await store.appendVersion(input);
        expect(created.skill_id).toBe("sk-create");
        expect(created.version).toBe(1);
        expect(created.is_head).toBe(true);

        const head = await store.getHead("sk-create", "team-a");
        expect(head).not.toBeNull();
        expect(head!.version).toBe(1);
        expect(head!.name).toBe("create-me");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("second appendVersion → v2 head, v1 demoted, versions listed DESC", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-ver", name: "versioned", content: "v1" }));
        const v2 = await store.appendVersion(makeInput({ skill_id: "sk-ver", name: "versioned", content: "v2" }));
        expect(v2.version).toBe(2);
        expect(v2.is_head).toBe(true);

        const head = await store.getHead("sk-ver", "team-a");
        expect(head!.version).toBe(2);

        const v1 = await store.getByVersion("sk-ver", 1, "team-a");
        expect(v1).not.toBeNull();
        expect(v1!.is_head).toBe(false);

        expect(await store.countVersions("sk-ver", "team-a")).toBe(2);
        const versions = await store.listVersions("sk-ver", "team-a");
        expect(versions.map((v) => v.version)).toEqual([2, 1]);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("listSkills returns head-only", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-list", name: "list-a", content: "v1" }));
        await store.appendVersion(makeInput({ skill_id: "sk-list", name: "list-a", content: "v2" }));
        const { items } = await store.listSkills({ team_id: "team-a" });
        const rows = items.filter((s) => s.skill_id === "sk-list");
        expect(rows).toHaveLength(1);
        expect(rows[0].version).toBe(2);
        expect(rows[0].is_head).toBe(true);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("searchSkills (BM25) recalls by keyword", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({
          skill_id: "sk-search-kube",
          name: "kubernetes-deploy",
          description: "Deploy services to a kubernetes cluster",
        }));
        await store.appendVersion(makeInput({
          skill_id: "sk-search-tea",
          name: "brew-tea",
          description: "Steep a nice cup of tea",
        }));

        const hits = await searchExpect(
          () => Promise.resolve(store.searchSkills({ team_id: "team-a", query: "kubernetes", mode: "bm25", topK: 10 })),
          (rows) => rows.some((r) => r.skill.skill_id === "sk-search-kube"),
        );
        expect(hits.some((r) => r.skill.skill_id === "sk-search-kube")).toBe(true);
        expect(hits.every((r) => typeof r.score === "number")).toBe(true);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("archiveHead soft-deletes (getHead null, getHeadIncludingArchived visible)", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-arch", name: "archive-me" }));
        const res = await store.archiveHead("sk-arch", "team-a");
        expect(res.archived).toBe(true);

        expect(await store.getHead("sk-arch", "team-a")).toBeNull();
        const arch = await store.getHeadIncludingArchived("sk-arch", "team-a");
        expect(arch).not.toBeNull();
        expect(arch!.status).toBe("archived");
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("a row without scope or audit values reads back with the defaults", async () => {
      const store = await harness.createStore();
      try {
        const created = await store.appendVersion(makeInput({ skill_id: "sk-defaults", name: "defaults-skill" }));
        expect(created).toMatchObject({
          scope: "global", project_key: "", project_hash: "", project_name: "", origin: "extracted",
          source_session_id: "", change_source: "", change_reason: "", change_summary: [],
          approved_by: "", approved_at_ms: 0, base_version: 0, proposal_id: "",
        });
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("scope and audit values round-trip, and a later version without scope keeps the head's", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({
          skill_id: "sk-scope", name: "scoped-skill",
          scope: "project", project_key: "git:example/app", project_hash: "0123456789abcdef", project_name: "example/app",
          origin: "extracted", source_session_id: "sess-1",
          change_source: "extracted", change_reason: "seen twice", change_summary: ["adds a", "fixes b"],
          approved_by: "u1", approved_at_ms: 1234, base_version: 0, proposal_id: "prp-1",
        }));
        // A writer that predates scope must not move the skill to global.
        await store.appendVersion(makeInput({ skill_id: "sk-scope", name: "scoped-skill", content: "v2" }));

        const v1 = await store.getByVersion("sk-scope", 1, "team-a");
        expect(v1).toMatchObject({
          scope: "project", project_key: "git:example/app", project_hash: "0123456789abcdef", project_name: "example/app",
          origin: "extracted", source_session_id: "sess-1", change_source: "extracted", change_reason: "seen twice",
          change_summary: ["adds a", "fixes b"], approved_by: "u1", approved_at_ms: 1234, proposal_id: "prp-1",
        });
        const head = await store.getHead("sk-scope", "team-a");
        expect(head).toMatchObject({ version: 2, scope: "project", project_hash: "0123456789abcdef", origin: "extracted" });
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("a name used in another scope or project gives SKILL_NAME_SCOPE_CONFLICT", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-n1", name: "same-name", scope: "global" }));
        await expect(
          store.appendVersion(makeInput({ skill_id: "sk-n2", name: "same-name", scope: "project", project_hash: "0123456789abcdef" })),
        ).rejects.toMatchObject({ code: "SKILL_NAME_SCOPE_CONFLICT" });
        await expect(
          store.appendVersion(makeInput({ skill_id: "sk-n3", name: "same-name", scope: "global" })),
        ).rejects.toMatchObject({ code: "SKILL_NAME_DUPLICATE" });
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("proposals: insert, get, list by status, and compare-and-set transitions", async () => {
      const store = await harness.createStore();
      try {
        const p = makeProposal({ proposal_id: "prp-a", created_at_ms: 1000 });
        const q = makeProposal({ proposal_id: "prp-b", created_at_ms: 2000, owner_agent_id: "agent-b" });
        await store.insertProposal(p);
        await store.insertProposal(q);

        expect(await store.getProposal("prp-a", "team-a")).toMatchObject({
          proposal_id: "prp-a", status: "pending", change_summary: ["adds a"], proposed_files: { write: [], remove: [] },
        });
        expect(await store.getProposal("prp-a", "other-team")).toBeNull();

        const all = await store.listProposals({ team_id: "team-a" });
        expect(all.total).toBe(2);
        expect(all.items.map((i) => i.proposal_id)).toEqual(["prp-b", "prp-a"]);
        expect((await store.listProposals({ team_id: "team-a", owner_agent_id: "agent-b" })).total).toBe(1);
        expect((await store.listProposals({ team_id: "team-a", created_before_ms: 1500 })).items.map((i) => i.proposal_id)).toEqual(["prp-a"]);

        // Only one writer wins a transition; the loser sees null.
        const won = await store.transitionProposal("prp-a", ["pending"], { status: "approved", decided_at_ms: 5, decided_by: "u", result_version: 0 });
        expect(won).toMatchObject({ status: "approved", decided_by: "u" });
        const lost = await store.transitionProposal("prp-a", ["pending"], { status: "rejected", decided_at_ms: 6, decided_by: "v", result_version: 0 });
        expect(lost).toBeNull();
        expect((await store.getProposal("prp-a"))?.status).toBe("approved");

        expect((await store.listProposals({ team_id: "team-a", status: ["pending"] })).total).toBe(1);
        expect((await store.listProposals({ team_id: "team-a", status: ["pending", "approved"] })).total).toBe(2);
      } finally {
        await harness.disposeStore(store);
      }
    });

    it("deleteAllVersions physically removes every version row", async () => {
      const store = await harness.createStore();
      try {
        await store.appendVersion(makeInput({ skill_id: "sk-del", name: "delete-me", content: "v1" }));
        await store.appendVersion(makeInput({ skill_id: "sk-del", name: "delete-me", content: "v2" }));

        const deleted = await store.deleteAllVersions("sk-del", "team-a");
        expect(deleted).toBe(2);
        expect(await store.getHeadIncludingArchived("sk-del", "team-a")).toBeNull();
        expect(await store.countVersions("sk-del", "team-a")).toBe(0);
      } finally {
        await harness.disposeStore(store);
      }
    });
  });
}
