import { describe, it, expect } from "vitest";
import { resolveMemoryProject, resolveUnanimousProject } from "./l1-project.js";

const A = { projectKey: "git:github.com/acme/app", projectHash: "0123456789abcdef" };
const B = { projectKey: "git:github.com/acme/other", projectHash: "fedcba9876543210" };
const NONE = { projectKey: "", projectHash: "" };

describe("resolveUnanimousProject", () => {
  it("returns the shared project when all items agree", () => {
    expect(resolveUnanimousProject([A, { ...A }, { ...A }])).toEqual(A);
  });

  it("returns the project of a single item", () => {
    expect(resolveUnanimousProject([A])).toEqual(A);
  });

  it("returns no project when items disagree", () => {
    expect(resolveUnanimousProject([A, B])).toEqual(NONE);
  });

  it("returns no project when any item has no project", () => {
    expect(resolveUnanimousProject([A, {}, A])).toEqual(NONE);
    expect(resolveUnanimousProject([A, NONE])).toEqual(NONE);
    expect(resolveUnanimousProject([{}, A])).toEqual(NONE);
  });

  it("returns no project when only one half of the pair is set", () => {
    expect(resolveUnanimousProject([{ projectKey: A.projectKey }])).toEqual(NONE);
    expect(resolveUnanimousProject([{ projectHash: A.projectHash }])).toEqual(NONE);
  });

  it("returns no project for an empty list", () => {
    expect(resolveUnanimousProject([])).toEqual(NONE);
  });
});

describe("resolveMemoryProject", () => {
  const pool = [
    { id: "m1", ...A },
    { id: "m2", ...A },
    { id: "m3", ...B },
    { id: "m4" },
  ];

  it("uses only the cited source messages", () => {
    expect(resolveMemoryProject(["m1", "m2"], pool)).toEqual(A);
    expect(resolveMemoryProject(["m3"], pool)).toEqual(B);
  });

  it("returns no project when cited sources disagree", () => {
    expect(resolveMemoryProject(["m1", "m3"], pool)).toEqual(NONE);
  });

  it("returns no project when a cited source has no project", () => {
    expect(resolveMemoryProject(["m1", "m4"], pool)).toEqual(NONE);
  });

  it("returns no project when a cited id is not in the pool", () => {
    expect(resolveMemoryProject(["m1", "missing"], pool)).toEqual(NONE);
  });

  it("falls back to the batch when no source is cited", () => {
    expect(resolveMemoryProject([], [{ id: "m1", ...A }, { id: "m2", ...A }])).toEqual(A);
    expect(resolveMemoryProject([], pool)).toEqual(NONE);
  });

  it("uses the explicit fallback instead of the lookup pool", () => {
    const fallback = [{ id: "m1", ...A }];
    expect(resolveMemoryProject([], pool, fallback)).toEqual(A);
  });

  it("returns no project when there are no sources at all", () => {
    expect(resolveMemoryProject([], [])).toEqual(NONE);
  });
});
