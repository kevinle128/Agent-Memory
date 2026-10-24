import { describe, expect, it } from "vitest";

import { DefaultChangeApprovalPolicy } from "./change-approval-policy.js";
import type { Skill } from "./types.js";

const policy = new DefaultChangeApprovalPolicy();

const globalSkill = { scope: "global" } as Skill;
const projectSkill = { scope: "project" } as Skill;

describe("DefaultChangeApprovalPolicy", () => {
  it("applies a change to a project skill, whoever makes it", () => {
    expect(policy.decide({ kind: "update", source: "extracted" }, projectSkill, "code")).toBe("apply");
    expect(policy.decide({ kind: "update", source: "manual" }, projectSkill, "code")).toBe("apply");
  });

  it("asks for approval when the system changes a global skill", () => {
    expect(policy.decide({ kind: "update", source: "extracted" }, globalSkill, "code")).toBe("require_approval");
    expect(policy.decide({ kind: "files", source: "extracted" }, globalSkill, "code")).toBe("require_approval");
  });

  it.each(["manual", "rollback", "promotion", "template"] as const)(
    "applies a %s change a person makes to a global skill",
    (source) => {
      expect(policy.decide({ kind: "update", source }, globalSkill, "code")).toBe("apply");
    },
  );

  it("applies every change in chat mode", () => {
    expect(policy.decide({ kind: "update", source: "extracted" }, globalSkill, "chat")).toBe("apply");
  });

  it("applies a new skill: it replaces nothing", () => {
    expect(policy.decide({ kind: "create", source: "extracted" }, null, "code")).toBe("apply");
  });
});
