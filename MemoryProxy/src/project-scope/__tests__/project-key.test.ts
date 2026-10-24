import { describe, expect, it } from "vitest";

import { buildProjectIdentity, normalizeRemote, projectHash } from "../project-key.js";

describe("normalizeRemote", () => {
  it.each([
    ["https://gitlab.example.com/Team/Demo-Repo.git", "gitlab.example.com/team/demo-repo"],
    ["https://user:secret@gitlab.example.com/Team/Demo-Repo.git", "gitlab.example.com/team/demo-repo"],
    ["ssh://git@gitlab.example.com:2222/Team/Demo-Repo.git", "gitlab.example.com/team/demo-repo"],
    ["git@gitlab.example.com:Team/Demo-Repo.git", "gitlab.example.com/team/demo-repo"],
    ["gitlab.example.com:Team/Demo-Repo", "gitlab.example.com/team/demo-repo"],
    ["https://github.com/kevinle128/Agent-Memory/", "github.com/kevinle128/agent-memory"],
    ["git://host.example/a/b/c.git", "host.example/a/b/c"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRemote(input)).toBe(expected);
  });

  it("gives the same key for https, ssh and scp forms of one repository", () => {
    const forms = [
      "https://gitlab.example.com/Team/Demo-Repo.git",
      "ssh://git@gitlab.example.com/Team/Demo-Repo.git",
      "git@gitlab.example.com:Team/Demo-Repo.git",
    ];
    expect(new Set(forms.map(normalizeRemote)).size).toBe(1);
  });

  it.each([null, undefined, "", "   ", "not a remote", "https://host-only"])("returns null for %s", (input) => {
    expect(normalizeRemote(input as string | null | undefined)).toBeNull();
  });
});

describe("buildProjectIdentity", () => {
  it("uses the remote when there is one", () => {
    const id = buildProjectIdentity({
      gitRemote: "git@gitlab.example.com:Team/Demo-Repo.git",
      gitToplevel: "/Users/dale/src/demo",
      deviceId: "d1",
    });
    expect(id.projectKey).toBe("git:gitlab.example.com/team/demo-repo");
    expect(id.projectLabel).toBe("gitlab.example.com/team/demo-repo");
    expect(id.projectHash).toBe(projectHash("git:gitlab.example.com/team/demo-repo"));
    expect(id.projectHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives clones on two machines the same key", () => {
    const a = buildProjectIdentity({ gitRemote: "https://h/x/y.git", gitToplevel: "/a/y", deviceId: "d1" });
    const b = buildProjectIdentity({ gitRemote: "git@h:x/y.git", gitToplevel: "/b/y", deviceId: "d2" });
    expect(a.projectKey).toBe(b.projectKey);
  });

  it("falls back to the device and toplevel when there is no remote", () => {
    const id = buildProjectIdentity({ gitRemote: null, gitToplevel: "/Users/dale/src/scratch/", deviceId: "d1" });
    expect(id.projectKey).toBe("local:d1:/Users/dale/src/scratch");
    expect(id.projectLabel).toBe("scratch");
  });

  it("returns no project for a folder outside git", () => {
    expect(buildProjectIdentity({ gitRemote: null, gitToplevel: null, deviceId: "d1" })).toEqual({
      projectKey: null,
      projectHash: null,
      projectLabel: null,
      projectName: null,
    });
  });

  it.each([
    ["https://github.com/kevinle128/paseo", "kevinle128/paseo"],
    ["git@github.com:kevinle128/paseo.git", "kevinle128/paseo"],
    ["ssh://git@github.com:22/kevinle128/paseo.git", "kevinle128/paseo"],
    ["https://git.oceanlabs.dev/vtc/3q-chess/3q-game-api", "vtc/3q-chess/3q-game-api"],
    ["https://GitLab.Example.com/Team/Sub/Demo-Repo.git", "team/sub/demo-repo"],
  ])("names the project from the remote path without the host: %s", (gitRemote, expected) => {
    expect(buildProjectIdentity({ gitRemote, gitToplevel: "/x/other", deviceId: "d1" }).projectName).toBe(expected);
  });

  it("names the project after the toplevel folder when there is no remote", () => {
    const id = buildProjectIdentity({ gitRemote: null, gitToplevel: "/Users/dale/src/scratch/", deviceId: "d1" });
    expect(id.projectName).toBe("scratch");
    expect(id.projectName).toBe(id.projectLabel);
  });

  it("drops a query string or fragment from the name but not from the key", () => {
    const id = buildProjectIdentity({ gitRemote: "https://h.example/a/b?token=x#frag", gitToplevel: null, deviceId: "d1" });
    expect(id.projectName).toBe("a/b");
    expect(id.projectKey).toBe("git:h.example/a/b?token=x#frag");
  });

  it.each(["/x/a<b>", "/x/a\u2028b", "/x/a\u202eb", "/x/a\u0085b"])(
    "gives no name for a folder name with unsafe characters: %s",
    (gitToplevel) => {
      const id = buildProjectIdentity({ gitRemote: null, gitToplevel: JSON.parse(`"${gitToplevel}"`), deviceId: "d1" });
      expect(id.projectName).toBeNull();
      expect(id.projectHash).not.toBeNull();
    },
  );

  it("keeps the key and hash unchanged by the name", () => {
    const id = buildProjectIdentity({ gitRemote: "git@github.com:kevinle128/paseo.git", gitToplevel: null, deviceId: "d1" });
    expect(id.projectKey).toBe("git:github.com/kevinle128/paseo");
    expect(id.projectHash).toBe(projectHash("git:github.com/kevinle128/paseo"));
  });
});
