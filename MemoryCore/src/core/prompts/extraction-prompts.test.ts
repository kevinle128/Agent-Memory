import { describe, expect, it } from "vitest";

import { EXTRACT_MEMORIES_SYSTEM_PROMPT, EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT } from "./l1-extraction.js";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

const marker = "仅针对单次任务的指令";
const keep = "只有当内容被明确表述为长期规则";

describe("one-task directive rule in L1 prompts", () => {
  it("is present in the chat prompt", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain(marker);
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain(keep);
  });

  it("is present in the work prompt, including the work_task and work_method sections", () => {
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).toContain(marker);
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).toContain(keep);
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).toContain("不是项目的 work_task");
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).toContain("不是 work_method");
  });
});

describe("one-task directive rule in scene prompts", () => {
  const params = {
    memoriesJson: "[]",
    sceneSummaries: "",
    currentTimestamp: "2026-10-23T00:00:00+07:00",
    maxScenes: 10,
  };

  it("is present in the work variant", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...params, promptMode: "code" });
    expect(systemPrompt).toContain(marker);
    expect(systemPrompt).toContain("SOP、禁忌和原则章节不得包含单次任务指令");
    expect(systemPrompt).toContain(keep);
  });

  it("does not change the chat variant", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...params, promptMode: "chat" });
    expect(systemPrompt).not.toContain(marker);
  });
});
