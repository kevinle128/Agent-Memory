import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFormResponse, type FormData } from "../form.js";

const teams = [
  { team_id: "team-aaaaaaaa1111", team_name: "Alpha", agents: [], tasks: [] },
  { team_id: "team-bbbbbbbb2222", team_name: "Beta", agents: [], tasks: [] },
] as unknown as FormData["teams"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildFormResponse", () => {
  it("keeps the byte layout of the session-init form stream", async () => {
    const res = buildFormResponse({ teams, stage: "asset_confirm", modelId: "test-model" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await res.text()).toMatchSnapshot();
  });

  it("keeps the byte layout of the team form stream", async () => {
    const res = buildFormResponse({ teams, stage: "team", modelId: "test-model", retry: true });
    expect(await res.text()).toMatchSnapshot();
  });
});
