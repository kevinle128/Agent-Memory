import { describe, expect, it } from "vitest";

import { buildPersonaPrompt, type PersonaPromptParams } from "./persona-generation.js";

const base: PersonaPromptParams = {
  mode: "first",
  currentTime: "2026-10-23T00:00:00.000Z",
  totalProcessed: 3,
  sceneCount: 2,
  changedSceneCount: 2,
  changedScenesContent: "scene text",
  personaFilePath: "persona.md",
  checkpointPath: ".metadata/checkpoint.json",
};

describe("buildPersonaPrompt variants", () => {
  it("selects the project prompt for both prompt modes", () => {
    const chat = buildPersonaPrompt({ ...base, variant: "project", promptMode: "chat" });
    const code = buildPersonaPrompt({ ...base, variant: "project", promptMode: "code" });

    expect(chat.systemPrompt).toContain("Project Memory Architect");
    expect(code.systemPrompt).toBe(chat.systemPrompt);
    expect(chat.systemPrompt).toContain("1500");
    expect(chat.systemPrompt).not.toContain("跨项目通用");
  });

  it("keeps the file-tool contract and bans personal traits and navigation", () => {
    const { systemPrompt } = buildPersonaPrompt({ ...base, variant: "project" });

    expect(systemPrompt).toContain("**write**");
    expect(systemPrompt).toContain("**edit**");
    expect(systemPrompt).toContain("只能操作 `persona.md` 这一个文件");
    expect(systemPrompt).toContain("不要添加场景导航");
    expect(systemPrompt).toContain("个人画像");
    expect(systemPrompt).toContain("与变化场景内容相同的语言");
  });

  it("covers the six project sections", () => {
    const { systemPrompt } = buildPersonaPrompt({ ...base, variant: "project" });

    for (const heading of ["Purpose & Scope", "Architecture", "Conventions & Workflow", "Decisions", "Status & Open Issues", "Pitfalls"]) {
      expect(systemPrompt, heading).toContain(heading);
    }
  });

  it("states the project size limit in the user prompt for an existing document", () => {
    const { userPrompt } = buildPersonaPrompt({
      ...base,
      mode: "incremental",
      variant: "project",
      existingPersona: "# Project Memory\n\nExisting body",
    });

    expect(userPrompt).toContain("Existing body");
    expect(userPrompt).toContain("1500");
    expect(userPrompt).not.toContain("2000字");
  });

  it("leaves the user-global prompts unchanged when no variant is given", () => {
    const chat = buildPersonaPrompt({ ...base, promptMode: "chat" });
    const code = buildPersonaPrompt({ ...base, promptMode: "code" });
    const explicit = buildPersonaPrompt({ ...base, promptMode: "chat", variant: "user-global" });

    expect(chat.systemPrompt).toContain("Persona Architect");
    expect(code.systemPrompt).toContain("Team Operating Doctrine Architect");
    expect(explicit).toEqual(chat);
  });
});
