import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteMetadataStore } from "./store/sqlite-adapter.js";
import { MetadataService } from "./service/metadata-service.js";
import { DEFAULT_SUPPORTED_AGENTS_FALLBACK } from "./default-supported-agents.js";

const agents = [...DEFAULT_SUPPORTED_AGENTS_FALLBACK];

describe("default supported agents", () => {
  it("lists omp as the only pi-family agent and marks the multi-source agents", () => {
    const names = agents.map((a) => a.agent_source);
    expect(names).toContain("omp");
    expect(names).not.toContain("pi");
    const multi = agents.filter((a) => a.multi_source === true).map((a) => a.agent_source).sort();
    expect(multi).toEqual(["hermes", "omp", "openclaw"]);
    expect(agents.find((a) => a.agent_source === "claude-code")?.multi_source).toBeUndefined();
    expect(agents.find((a) => a.agent_source === "codex")?.multi_source).toBeUndefined();
  });

  describe("with a metadata service", () => {
    let store: SqliteMetadataStore;
    let svc: MetadataService;

    beforeEach(() => {
      store = new SqliteMetadataStore(":memory:");
      store.init();
      svc = new MetadataService(store, "default");
    });

    afterEach(async () => {
      await store.close();
    });

    it("seeds omp into the default group", async () => {
      await store.ensureDefaultSeeded(agents);
      const groups = await store.listInstanceUpstreamGroups(undefined, agents);
      const def = groups.find((g) => g.group_type === "default");
      expect(def?.agents).toContain("omp");
      expect(def?.agents).not.toContain("pi");
    });

    it("rejects a custom group that names pi", async () => {
      await expect(
        svc.createInstanceUpstreamCustomGroup(
          { name: "legacy", agents: ["pi"], mode: "custom_unified", base_url: "https://example.test", api_key: "k" },
          agents,
        ),
      ).rejects.toMatchObject({ code: "INVALID_AGENTS" });
    });
  });
});
