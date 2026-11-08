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
    expect(chat.systemPrompt).not.toContain("Scope: Cross-Project");
  });

  it("keeps the file-tool contract and bans personal traits and navigation", () => {
    const { systemPrompt } = buildPersonaPrompt({ ...base, variant: "project" });

    expect(systemPrompt).toContain("**write**");
    expect(systemPrompt).toContain("**edit**");
    expect(systemPrompt).toContain("only one file, `persona.md`");
    expect(systemPrompt).toContain("Do not add scene navigation");
    expect(systemPrompt).toContain("No personal profile");
    expect(systemPrompt).toContain("in the same language as the changed scene content");
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
    expect(userPrompt).not.toContain("2000 characters");
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

describe("one-task directive rule", () => {
  const marker = "instructions that apply only to a single task";
  const keep = "only when the content is explicitly stated as a long-term rule";

  it("is present in the project, team and user-global persona prompts", () => {
    const project = buildPersonaPrompt({ ...base, variant: "project" }).systemPrompt;
    const team = buildPersonaPrompt({ ...base, promptMode: "code" }).systemPrompt;
    const user = buildPersonaPrompt({ ...base, promptMode: "chat" }).systemPrompt;

    for (const prompt of [project, team, user]) {
      expect(prompt).toContain(marker);
      expect(prompt).toContain("do not commit");
      expect(prompt).toContain(keep);
    }
  });
});
