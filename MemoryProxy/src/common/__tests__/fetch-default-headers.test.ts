import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installFetchDefaultHeaderFilter, withoutFetchDefaultHeaders } from "../fetch-default-headers.js";

async function rawHeadersSeenByServer(headers: Record<string, string>): Promise<string[]> {
  const server = http.createServer((req, res) => res.end(JSON.stringify(req.rawHeaders)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return JSON.parse(await res.text()) as string[];
  } finally {
    server.close();
  }
}

function names(raw: string[]): string[] {
  return raw.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
}

describe("fetch default header filter", () => {
  it("removes sec-fetch-mode and accept-language: * from object and array headers", () => {
    expect(withoutFetchDefaultHeaders({ "x-a": "1", "sec-fetch-mode": "cors", "accept-language": "*" })).toEqual({ "x-a": "1" });
    expect(withoutFetchDefaultHeaders(["x-a", "1", "Sec-Fetch-Mode", "cors", "accept-language", "*"])).toEqual(["x-a", "1"]);
  });

  it("keeps a real accept-language value", () => {
    expect(withoutFetchDefaultHeaders({ "accept-language": "vi-VN" })).toEqual({ "accept-language": "vi-VN" });
  });

  it("stops fetch from sending its own sec-fetch-mode and accept-language: *", async () => {
    await installFetchDefaultHeaderFilter();
    await installFetchDefaultHeaderFilter(); // a second call changes nothing

    const plain = names(await rawHeadersSeenByServer({ "x-app": "cli", "user-agent": "claude-cli/test" }));
    expect(plain).not.toContain("sec-fetch-mode");
    expect(plain).not.toContain("accept-language");
    expect(plain).toContain("x-app");

    const raw = await rawHeadersSeenByServer({ "accept-language": "vi-VN" });
    expect(raw[raw.findIndex((n) => n.toLowerCase() === "accept-language") + 1]).toBe("vi-VN");
  });
});
