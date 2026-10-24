import { describe, expect, it, vi } from "vitest";

import type { LLMRunner } from "../types.js";
import {
  USER_GLOBAL_REJECTED_MARKER,
  USER_GLOBAL_SCOPE_MARKER,
  buildScopeJudgePrompt,
  checkUserGlobalPersona,
  findStructuralLeaks,
  parseJudgeLeaks,
  readScopeState,
  stripScopeMarkers,
} from "./user-global-scope.js";

/** A project-free persona in the shape the chat template produces. */
const CLEAN_PERSONA = `# User Narrative Profile

> **Archetype (Mẫu hình cốt lõi)**: Một người xây dựng dẫn dắt bằng bằng chứng.

> **Thông tin cơ bản**
- Không có thông tin nhân khẩu học hoặc nghề nghiệp được xác nhận.

> **Sở thích dài hạn**
- Ưu tiên bằng chứng quan sát được trước khi kết luận.
- Thay đổi nhỏ, đúng phạm vi, có đường lui.

## 🤖 Chương 3: Giao tiếp & Quy trình nhận thức

### 3.1 Chiến lược giao tiếp
Báo cáo kết quả trước, tách rõ phần đã kiểm chứng và phần chưa chắc chắn. Giới hạn 2.000 ký tự.

### 3.2 Logic ra quyết định
Chỉ hành động khi phạm vi và quyền tác động đã được xác nhận.

* **Đặc tính nổi bật**:
  - evidence-led — chỉ tin kết luận có kiểm chứng.
  - boundary-conscious — phân quyền rõ giữa review và deploy.`;

function judgeReturning(output: string | Error): LLMRunner {
  return {
    run: vi.fn(async () => {
      if (output instanceof Error) throw output;
      return output;
    }),
  };
}

describe("readScopeState / stripScopeMarkers", () => {
  it("reads the accepted marker on the first line", () => {
    expect(readScopeState(`${USER_GLOBAL_SCOPE_MARKER}\n# Profile`)).toBe("accepted");
  });

  it("reads the rejected marker", () => {
    expect(readScopeState(`\n${USER_GLOBAL_REJECTED_MARKER}\n# Profile`)).toBe("rejected");
  });

  it("reads a persona without marker as none", () => {
    expect(readScopeState("# Profile\n- Đang làm việc với Agent-Memory")).toBe("none");
  });

  it("strips markers wherever they appear", () => {
    const text = `${USER_GLOBAL_SCOPE_MARKER}\n# Profile\n${USER_GLOBAL_REJECTED_MARKER}\n- a`;
    expect(stripScopeMarkers(text)).toBe("# Profile\n- a");
  });

  it("cuts a marker that shares a line with text and keeps the text", () => {
    expect(stripScopeMarkers(`${USER_GLOBAL_SCOPE_MARKER} # Project Memory\n- a`)).toBe("# Project Memory\n- a");
    expect(stripScopeMarkers(`# Title\n- a ${USER_GLOBAL_REJECTED_MARKER} b`)).toBe("# Title\n- a  b");
  });

  it("cuts two markers on one line, and drops a line that holds only markers", () => {
    const both = `${USER_GLOBAL_SCOPE_MARKER}${USER_GLOBAL_REJECTED_MARKER} # Project Memory`;
    expect(stripScopeMarkers(`${both}\n- a`)).toBe("# Project Memory\n- a");
    expect(stripScopeMarkers(`# Title\n  ${USER_GLOBAL_SCOPE_MARKER} ${USER_GLOBAL_REJECTED_MARKER}  \n- a`)).toBe("# Title\n- a");
  });

  it("leaves text without a marker unchanged", () => {
    expect(stripScopeMarkers("# Profile\n  - indented\n")).toBe("# Profile\n  - indented");
  });
});

describe("findStructuralLeaks", () => {
  it("finds nothing in a clean Vietnamese persona with section numbers and lowercase tags", () => {
    expect(findStructuralLeaks(CLEAN_PERSONA)).toEqual([]);
  });

  it.each([
    ["absolute path", "Làm việc trong /Users/dale/Movies mỗi ngày", "/Users/dale/Movies"],
    ["home path", "Cấu hình ở ~/.claude/settings.json", "~/.claude/settings.json"],
    ["git host", "Mã nằm trên gitlab nội bộ", "gitlab"],
    ["url", "Xem https://example.com/x", "https://example.com/x"],
    ["file name", "Luôn sửa config.yaml trước", "config.yaml"],
    ["three-part version", "Giữ nguyên bản 4.0.290", "4.0.290"],
    ["v-prefixed version", "Dùng v2.1 của công cụ", "v2.1"],
    ["dimensions", "Video dọc 1080×1920", "1080×1920"],
    ["code span", "Chạy `npm test` trước khi commit", "`npm test`"],
    ["CamelCase name", "Pipeline ShortReel cho video", "ShortReel"],
    ["brand in camel case", "Giữ hành vi YouTube", "YouTube"],
    ["hyphenated project name", "Đang làm việc với Agent-Memory", "Agent-Memory"],
  ])("finds a %s", (_label, text, expected) => {
    expect(findStructuralLeaks(text)).toContain(expected);
  });
});

describe("parseJudgeLeaks", () => {
  it("parses an empty leak list", () => {
    expect(parseJudgeLeaks('{"leaks": []}')).toEqual([]);
  });

  it("parses leaks inside a code fence", () => {
    expect(parseJudgeLeaks('```json\n{"leaks": ["Remotion", "Udemy"]}\n```')).toEqual(["Remotion", "Udemy"]);
  });

  it("returns null for prose", () => {
    expect(parseJudgeLeaks("The profile looks fine.")).toBeNull();
  });

  it("returns null when leaks is not an array", () => {
    expect(parseJudgeLeaks('{"leaks": "none"}')).toBeNull();
  });
});

describe("buildScopeJudgePrompt", () => {
  it("includes the scene index so that project names are known to the judge", () => {
    const { prompt } = buildScopeJudgePrompt("# P", [{ filename: "Agent-Memory-Chay-Local.md", summary: "local run" }]);
    expect(prompt).toContain("Agent-Memory-Chay-Local.md — local run");
    expect(prompt).toContain("# P");
  });
});

describe("checkUserGlobalPersona", () => {
  const scenes = [{ filename: "Green-Screen-Matting-for-Remotion.md", summary: "Remotion pipeline" }];

  it("passes a clean persona when the judge finds no leak", async () => {
    const judge = judgeReturning('{"leaks": []}');
    await expect(checkUserGlobalPersona({ persona: CLEAN_PERSONA, sceneIndex: scenes, judge })).resolves.toMatchObject({
      ok: true,
      leaks: [],
    });
  });

  it("fails on structural leaks without calling the judge", async () => {
    const judge = judgeReturning('{"leaks": []}');
    const result = await checkUserGlobalPersona({ persona: "- Đang làm Agent-Memory", sceneIndex: scenes, judge });
    expect(result).toMatchObject({ ok: false, reason: "structural", leaks: ["Agent-Memory"] });
    expect(judge.run).not.toHaveBeenCalled();
  });

  it("fails with the judge's leaks for names no pattern can see", async () => {
    const judge = judgeReturning('{"leaks": ["Remotion"]}');
    const result = await checkUserGlobalPersona({ persona: "- Thích dựng video bằng Remotion", sceneIndex: scenes, judge });
    expect(result).toMatchObject({ ok: false, leaks: ["Remotion"], reason: "judge-leaks" });
    expect(judge.run).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the judge reply is not JSON", async () => {
    const result = await checkUserGlobalPersona({
      persona: CLEAN_PERSONA, sceneIndex: scenes, judge: judgeReturning("ok"),
    });
    expect(result).toMatchObject({ ok: false, reason: "judge-unparseable" });
  });

  it("reports a technical failure when the judge keeps throwing", async () => {
    const result = await checkUserGlobalPersona({
      persona: CLEAN_PERSONA,
      sceneIndex: scenes,
      judge: judgeReturning(new Error("connection reset")),
    });
    expect(result).toMatchObject({ ok: false, reason: "judge-error" });
  });
});
