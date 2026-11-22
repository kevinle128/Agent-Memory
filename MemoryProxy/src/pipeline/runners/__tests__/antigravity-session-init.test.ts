/**
 * AntiGravity session init through the real route table and the real shared state machine
 * (session/codebuddy/init.ts), with a fake Core metadata client. Order of the choice, as for
 * Claude Code and Codex: account default, header preset, auto-select of a single choice, and only
 * then a question. agy cannot show a tool question, so the question is a text turn of the
 * conversation (Gemini SSE) and the reply is the next user turn. Question and reply turns never go
 * upstream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../server.js";
import { __primeCacheForTests, type InstanceUpstreamRow } from "../../../instance-upstream-cache.js";
import { __primeAccountCacheForTests } from "../../../subscription-pool/account-cache.js";
import type { PoolAccount } from "../../../subscription-pool/types.js";
import { MemoryStorage } from "../../../storage/memory-storage.js";
import { SessionWorkspaceStore, setSessionWorkspaceStore } from "../../../project-scope/session-workspace.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../../session/store.js";
import { setMetadataClient, type MetadataClient } from "../../../meta/client.js";
import { isHeaderOnlyAgent } from "../../../session/preset.js";
import { detectClientCapabilities } from "../../../session/client-capabilities.js";
import { SESSION_INIT_BYPASS_MARKER, SESSION_INIT_MARKER, contentsToMessages, stripSessionInitTurns } from "../../../session/antigravity/session-init-text.js";
import { isAgySystemNotice, userRequestText } from "../../../session/antigravity/user-request.js";
import { extractUserMessage } from "../antigravity.js";
import { installFetch, makeConfig, resetPoolState } from "../../../subscription-pool/__tests__/test-harness.js";
import type { ProxyConfig } from "../../../types.js";

const SPACE = "sp-agy-init";
const KEY = "sk-mem-initkey";
const SESSION = "7b1d6b7e-9c1a-4e55-8f0b-2f6d3d9a1c22";
const NOW = Date.now();

vi.mock("../../../auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auth.js")>()),
  verifyUserKey: async () => ({ userId: "usr-1", rejected: false }),
}));

const defaultRow: InstanceUpstreamRow = {
  group_id: "d", group_type: "default", name: "default", agents: ["claude-code"], enabled: true,
  mode: "official", base_url: "", api_key: "", model_id: "",
};
const poolRow: InstanceUpstreamRow = {
  group_id: "pool-agy", group_type: "custom", name: "AGY pool", agents: ["antigravity"], enabled: true,
  mode: "subscription_pool", team_id: "team-a", base_url: "", api_key: "", model_id: "",
};
const account: PoolAccount = {
  account_id: "a", group_id: "pool-agy", provider: "antigravity", provider_account_id: "g-a", project_id: "proj-a",
  status: "active", enabled: true, access_token: "secret-token-a", token_expires_at: NOW + 3_600_000,
  usage: { windows: [] }, exhausted_until: null,
};

interface FakeData {
  teams: Array<{ team_id: string; name: string; agents: string[]; tasks: string[] }>;
  userDefault: { team_id: string; agent_id: string; task_id: string } | null;
}
let data: FakeData;

function fakeClient(): MetadataClient {
  const team = (id: string) => data.teams.find((t) => t.team_id === id);
  return {
    listTeams: async () => data.teams.map((t) => ({ team_id: t.team_id, name: t.name })),
    listAgents: async (teamId: string) => (team(teamId)?.agents ?? []).map((a) => ({ agent_id: a, team_id: teamId, name: `Agent ${a}` })),
    listTasks: async (teamId: string) => (team(teamId)?.tasks ?? []).map((k) => ({ task_id: k, team_id: teamId, title: `Task ${k}` })),
    getAgent: async (id: string) => ({ agent_id: id, team_id: "x", name: `Agent ${id}` }),
    getTask: async (id: string) => ({ task_id: id, team_id: "x", title: `Task ${id}` }),
    getUserSessionDefault: async () => data.userDefault,
    appendParticipationLog: async () => undefined,
  } as unknown as MetadataClient;
}

const sse = () => new Response(
  `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] } }] } })}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const user = (text: string) => ({ role: "user", parts: [{ text }] });
const model = (text: string) => ({ role: "model", parts: [{ text }] });
const body = (contents: unknown[]) => ({ contents, labels: { cascade_id: SESSION } });
const path = `/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`;

let app: ReturnType<typeof createApp>;
let calls: ReturnType<typeof installFetch>;

function configured(extra: Partial<ProxyConfig["sessionInit"]> = {}): ProxyConfig {
  const config = makeConfig();
  config.hookGate = { enabled: false };
  config.sessionInit = { ...(config.sessionInit ?? {}), enabled: true, skipAssetConfirm: true, defaultTaskId: undefined, ...extra } as ProxyConfig["sessionInit"];
  return config;
}

function post(contents: unknown[], headers: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body(contents)) });
}

/** The text of the one data line of a locally answered Gemini SSE stream. */
async function questionText(res: Response): Promise<string> {
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data:"))!;
  return JSON.parse(line.slice(5)).candidates[0].content.parts[0].text as string;
}

/** Calls to Cloud Code only: the capability lookup of the session goes to another host. */
const modelCalls = () => calls.upstreamCalls.filter((c) => c.url.includes("/v1internal:"));
const upstreamContents = (index = 0) => JSON.parse(modelCalls()[index]!.body).request.contents;

beforeEach(() => {
  resetPoolState();
  __resetSessionStoreForTests();
  data = {
    teams: [{ team_id: "tm-1", name: "Alpha", agents: ["ag-1"], tasks: ["tk-1"] }],
    userDefault: null,
  };
  setMetadataClient(fakeClient());
  setSessionWorkspaceStore(new SessionWorkspaceStore(new MemoryStorage()));
  __primeCacheForTests(SPACE, [defaultRow, poolRow]);
  __primeAccountCacheForTests(SPACE, { thresholdPct: 95, accounts: [account] });
  calls = installFetch(() => sse());
  for (const method of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  app = createApp(configured());
});
afterEach(() => {
  setMetadataClient(null);
  setSessionWorkspaceStore(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("antigravity session init", () => {
  it("registers from the account default and shows no question", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2", "ag-3"], tasks: ["tk-2", "tk-3"] });
    data.userDefault = { team_id: "tm-2", agent_id: "ag-3", task_id: "tk-3" };
    const res = await post([user("fix the bug")]);
    await res.text();
    expect(res.status).toBe(200);
    expect(modelCalls()).toHaveLength(1);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ status: "initialized", sessionInfo: { agent_id: "ag-3", team_id: "tm-2", task_id: "tk-3" } });
  });

  it("auto-registers when the user has one team, one agent and one task", async () => {
    const res = await post([user("fix the bug")]);
    await res.text();
    expect(modelCalls()).toHaveLength(1);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({
      status: "initialized", sessionInfo: { agent_id: "ag-1", team_id: "tm-1", task_id: "tk-1" },
    });
  });

  it("uses the header preset before any question", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2", "ag-3"], tasks: ["tk-2", "tk-3"] });
    const res = await post([user("fix the bug")], { "x-team-id": "tm-2", "x-agent-id": "ag-2", "x-task-id": "tk-3" });
    await res.text();
    expect(modelCalls()).toHaveLength(1);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ sessionInfo: { agent_id: "ag-2", task_id: "tk-3" } });
  });

  it("asks which team as a Gemini SSE text turn when several teams exist, and sends nothing upstream", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    const res = await post([user("fix the bug")]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await questionText(res);
    expect(text.startsWith(SESSION_INIT_MARKER)).toBe(true);
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(modelCalls()).toHaveLength(0);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ status: "pending_team_select" });
  });

  it("registers on a numeric reply and forwards the original prompt without the question and reply turns", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    const first = await post([user("fix the bug")]);
    const question = await questionText(first);

    const second = await post([user("fix the bug"), model(question), user("2")]);
    await second.text();
    expect(second.status).toBe(200);
    expect(modelCalls()).toHaveLength(1);
    expect(upstreamContents()).toEqual([user("fix the bug")]);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({
      status: "initialized", sessionInfo: { team_id: "tm-2", agent_id: "ag-2", task_id: "tk-2" },
    });

    // Later turns replay the whole history; the question turns stay out of every upstream request.
    const third = await post([user("fix the bug"), model(question), user("2"), model("answer"), user("thanks")]);
    await third.text();
    expect(upstreamContents(1)).toEqual([user("fix the bug"), model("answer"), user("thanks")]);
    expect(JSON.stringify(modelCalls().map((c) => c.body))).not.toContain(SESSION_INIT_MARKER);
  });

  it("asks again with a retry notice when the reply is not an option", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    const question = await questionText(await post([user("fix the bug")]));
    const again = await post([user("fix the bug"), model(question), user("banana")]);
    const text = await questionText(again);
    expect(text.startsWith(SESSION_INIT_MARKER)).toBe(true);
    expect(text).toContain("Alpha");
    expect(text).not.toBe(question);
    expect(modelCalls()).toHaveLength(0);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ status: "pending_team_select", attemptCount: 1 });
  });

  it("asks the agent question after the team when the team has several agents, one question per turn", async () => {
    data.teams = [
      { team_id: "tm-1", name: "Alpha", agents: ["ag-1", "ag-2"], tasks: ["tk-1"] },
      { team_id: "tm-2", name: "Beta", agents: ["ag-3"], tasks: ["tk-2"] },
    ];
    const q1 = await questionText(await post([user("go")]));
    const q2 = await questionText(await post([user("go"), model(q1), user("1")]));
    expect(q2.startsWith(SESSION_INIT_MARKER)).toBe(true);
    expect(q2).toContain("Agent ag-1");
    expect(q2).toContain("Agent ag-2");
    expect(modelCalls()).toHaveLength(0);
    const done = await post([user("go"), model(q1), user("1"), model(q2), user("2")]);
    await done.text();
    expect(modelCalls()).toHaveLength(1);
    expect(upstreamContents()).toEqual([user("go")]);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ sessionInfo: { team_id: "tm-1", agent_id: "ag-2" } });
  });

  it("does not ask a question for a side request (generateContent)", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    const res = await app.request(`/antigravity/${SPACE}/${KEY}/v1beta/models/gemini-3.8-flash:generateContent`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body([user("title please")])),
    });
    await res.text();
    expect(modelCalls()).toHaveLength(1);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toBeUndefined();
  });
});

/** The shape agy 1.5.9 sends: the typed text sits inside USER_REQUEST, other blocks follow. */
const wrapped = (typed: string, extra = true) =>
  `<USER_REQUEST>\n${typed}\n</USER_REQUEST>` + (extra
    ? "\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-19T08:52:22+07:00.\n</ADDITIONAL_METADATA>"
      + "\n<USER_SETTINGS_CHANGE>\nThe user changed settings: planning mode is off.\n</USER_SETTINGS_CHANGE>"
    : "");

describe("agy wrapped user text", () => {
  it("reads the typed text inside USER_REQUEST and falls back to the whole text", () => {
    expect(userRequestText(wrapped("yes"))).toBe("yes");
    expect(userRequestText(wrapped("yes", false))).toBe("yes");
    expect(userRequestText("  plain reply \n")).toBe("plain reply");
    expect(userRequestText("<USER_REQUEST>\n\n</USER_REQUEST>")).toBe("");
  });

  it("gives the state machine the typed reply, not the wrapped block", () => {
    const messages = contentsToMessages({ contents: [user(wrapped("fix it")), model("question"), user(wrapped("1"))] });
    expect(messages).toEqual([
      { role: "user", content: "fix it" }, { role: "assistant", content: "question" }, { role: "user", content: "1" },
    ]);
  });

  it("writes the typed text as the L0 user text", () => {
    expect(extractUserMessage(body([user(wrapped("pong"))]))).toEqual({ role: "user", content: "pong" });
    expect(extractUserMessage(body([user("pong")]))).toEqual({ role: "user", content: "pong" });
  });

  it("registers on a reply that agy wrapped, and forwards the wrapped prompt byte for byte", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    const prompt = user(wrapped("fix the bug"));
    const question = await questionText(await post([prompt]));
    const done = await post([prompt, model(question), user(wrapped("2"))]);
    await done.text();
    expect(modelCalls()).toHaveLength(1);
    expect(upstreamContents()).toEqual([prompt]);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ status: "initialized", sessionInfo: { team_id: "tm-2" } });
  });

  it("recognizes yes at the asset question when the reply is wrapped", async () => {
    app = createApp(configured({ skipAssetConfirm: false }));
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    const question = await questionText(await post([user(wrapped("fix the bug"))]));
    expect(question).toContain("yes");
    const next = await questionText(await post([user(wrapped("fix the bug")), model(question), user(wrapped("yes"))]));
    expect(next).not.toContain("Could not recognize");
    expect(next).toContain("Alpha");
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ status: "pending_team_select" });
  });
});

/** The notice that agy 1.5.9 appends as one more user turn after the typed one. */
const notice = () => user(
  "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n"
  + "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-19T08:52:30+07:00 sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>",
);

describe("agy system notices between and after typed turns", () => {
  it("tells a notice from typed text", () => {
    expect(isAgySystemNotice(notice().parts[0]!.text)).toBe(true);
    expect(isAgySystemNotice(wrapped("yes"))).toBe(false);
    expect(isAgySystemNotice("plain text")).toBe(false);
    expect(isAgySystemNotice(`<USER_REQUEST>\nquote <SYSTEM_MESSAGE> tag\n</USER_REQUEST>`)).toBe(false);
  });

  it("reads the typed turn as the reply, and the typed prompt as the L0 text, when a notice follows", () => {
    const contents = [user(wrapped("Reply OK.")), model("question"), user(wrapped("yes")), notice()];
    const messages = contentsToMessages(body(contents));
    expect(messages.at(-1)).toEqual({ role: "user", content: "yes" });
    expect(messages).toHaveLength(3);
    expect(extractUserMessage(body([user(wrapped("Reply OK.")), notice()]))).toEqual({ role: "user", content: "Reply OK." });
  });

  it("removes the question and every user turn after it, typed replies and notices alike", () => {
    const q = model(`${SESSION_INIT_MARKER}\nquestion`);
    const first = user(wrapped("Reply OK."));
    const input = body([first, q, user(wrapped("yes")), notice(), q, user(wrapped("yes")), notice()]);
    expect(stripSessionInitTurns(input)).toEqual({ ...input, contents: [first] });
  });

  it("registers on the real 7-turn history, asking again first when the reply was not an option", async () => {
    data.teams.push({ team_id: "tm-2", name: "Beta", agents: ["ag-2"], tasks: ["tk-2"] });
    app = createApp(configured({ skipAssetConfirm: false }));
    const first = user(wrapped("My favourite deploy tool is Komodo. Reply OK."));
    const q1 = await questionText(await post([first]));
    expect(q1).toContain("yes");

    // Turns 1-4: a notice follows the reply "yes"; the answer is the typed "yes", so the team question comes next.
    const q2 = await questionText(await post([first, model(q1), user(wrapped("yes")), notice()]));
    expect(q2).not.toContain("Could not recognize");
    expect(q2).toContain("Alpha");
    expect(modelCalls()).toHaveLength(0);

    // A reply that is not an option gets the question again with the retry notice.
    const again = await questionText(await post([first, model(q1), user(wrapped("yes")), notice(), model(q2), user(wrapped("zzz")), notice()]));
    expect(again.startsWith(SESSION_INIT_MARKER)).toBe(true);
    expect(again).toContain("Could not recognize");

    // A valid number registers; the upstream request holds the original prompt only.
    const done = await post([first, model(q1), user(wrapped("yes")), notice(), model(q2), user(wrapped("2")), notice()]);
    await done.text();
    expect(modelCalls()).toHaveLength(1);
    expect(upstreamContents()).toEqual([first]);
    expect(getSessionStore().get(`antigravity:${SESSION}`)).toMatchObject({ status: "initialized", sessionInfo: { team_id: "tm-2" } });
  });
});

describe("session init helpers", () => {
  it("removes each question turn and the reply that follows it, and nothing else", () => {
    const q = model(`${SESSION_INIT_MARKER}\nquestion`);
    const input = { contents: [user("a"), q, user("1"), model("b"), user("c"), q, user("2")], labels: { cascade_id: SESSION } };
    expect(stripSessionInitTurns(input)).toEqual({ ...input, contents: [user("a"), model("b"), user("c")] });
    const plain = { contents: [user("a"), model("b")] };
    expect(stripSessionInitTurns(plain)).toBe(plain);
  });

  it("removes a bypass notice but keeps the real prompt that follows it", () => {
    const q = model(`${SESSION_INIT_MARKER}\nquestion`);
    const bypass = model(`${SESSION_INIT_BYPASS_MARKER}\nnotice`);
    const input = { contents: [user("a"), q, user("zzz"), q, user("zzz"), q, user("zzz"), bypass, user("real prompt")] };
    expect(stripSessionInitTurns(input)).toEqual({ ...input, contents: [user("a"), user("real prompt")] });
  });

  it("keeps the header-only path of other agents and puts antigravity on the text mode", () => {
    expect(isHeaderOnlyAgent("antigravity")).toBe(false);
    expect(isHeaderOnlyAgent("omp")).toBe(true);
    expect(isHeaderOnlyAgent("hermes")).toBe(true);
    expect(detectClientCapabilities("antigravity", {})).toEqual({ askUserQuestion: false });
    expect(detectClientCapabilities("codex", {})).toEqual({ askUserQuestion: true });
    expect(detectClientCapabilities("omp", {})).toEqual({ askUserQuestion: true });
  });
});
