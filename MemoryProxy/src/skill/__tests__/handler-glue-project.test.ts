import { beforeEach, describe, expect, it, vi } from "vitest";

const addConversation = vi.fn();
vi.mock("../core-client.js", () => ({
  getCoreSkillClient: () => ({ addConversation }),
}));

import { projectFieldsOf, triggerSkillExtractIfReady, type TriggerInput } from "../handler-glue.js";

const PROJECT = {
  projectKey: "github.com/acme/widgets",
  projectHash: "0123456789abcdef",
  projectName: "acme/widgets",
};

function baseInput(extra: Partial<TriggerInput> = {}): TriggerInput {
  return {
    config: { coreSkill: { endpoint: "http://core", serviceToken: "t" } } as TriggerInput["config"],
    sessionKey: "sess-1",
    agentSource: "claude-code",
    sessionInfo: { user_id: "u", team_id: "t", agent_id: "a", space_id: "s" },
    inputMessages: [{ role: "user", content: "fix the build" }],
    assistantMessage: { role: "assistant", content: "done" },
    protocol: "openai",
    ...extra,
  };
}

describe("projectFieldsOf", () => {
  it("returns key, hash and name when the pair is complete", () => {
    expect(projectFieldsOf(PROJECT)).toEqual({
      project_key: PROJECT.projectKey,
      project_hash: PROJECT.projectHash,
      project_name: PROJECT.projectName,
    });
  });

  it("omits the name when it is absent", () => {
    expect(projectFieldsOf({ projectKey: "k", projectHash: "0123456789abcdef" })).toEqual({
      project_key: "k",
      project_hash: "0123456789abcdef",
    });
  });

  it("drops a half pair and a missing identity", () => {
    expect(projectFieldsOf({ projectKey: "k" })).toEqual({});
    expect(projectFieldsOf({ projectHash: "0123456789abcdef" })).toEqual({});
    expect(projectFieldsOf(null)).toEqual({});
    expect(projectFieldsOf(undefined)).toEqual({});
  });
});

describe("triggerSkillExtractIfReady project fields", () => {
  beforeEach(() => {
    addConversation.mockReset();
    addConversation.mockResolvedValue({ status: "ok" });
  });

  it("sends the project of the session with the round", async () => {
    await triggerSkillExtractIfReady(baseInput({ projectIdentity: PROJECT }));
    expect(addConversation).toHaveBeenCalledTimes(1);
    expect(addConversation.mock.calls[0]![0]).toMatchObject({
      session_id: "sess-1",
      project_key: PROJECT.projectKey,
      project_hash: PROJECT.projectHash,
      project_name: PROJECT.projectName,
    });
  });

  it("sends no project fields when the session has no project", async () => {
    await triggerSkillExtractIfReady(baseInput({ projectIdentity: null }));
    const body = addConversation.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("project_key");
    expect(body).not.toHaveProperty("project_hash");
    expect(body).not.toHaveProperty("project_name");
  });
});
