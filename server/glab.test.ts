import type { ExecFileException } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  graphqlArgs,
  isUnfinishedRun,
  parseAuthenticatedHosts,
  readAuthStatus,
} from "./glab";

describe("glab api graphql", () => {
  it("labels the stdin body as JSON so GitLab parses it", () => {
    const args = graphqlArgs("gitlab.example.dev");
    expect(args.slice(0, 4)).toEqual([
      "api",
      "graphql",
      "--hostname",
      "gitlab.example.dev",
    ]);
    const header = args.indexOf("--header");
    expect(args[header + 1]).toBe("Content-Type: application/json");
    expect(args.slice(-2)).toEqual(["--input", "-"]);
  });
});

describe("glab auth status", () => {
  it("collects only the hosts glab reports as logged in", () => {
    const status = [
      "gitlab.com",
      "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401",
      "  ! No token found (checked config file, keyring, and environment variables).",
      "gitlab.example.dev",
      "  ✓ Logged in to gitlab.example.dev as tanuki (/home/me/config.yml)",
      "  ✓ Token found: **************************",
    ].join("\n");
    expect(parseAuthenticatedHosts(status)).toEqual(["gitlab.example.dev"]);
    expect(parseAuthenticatedHosts("")).toEqual([]);
  });

  it("tells an unfinished auth check apart from a logged-out glab", () => {
    const loggedIn = "  ✓ Logged in to gitlab.com as tanuki (keyring)";
    const exited = (code: number): ExecFileException =>
      Object.assign(new Error(`Command failed: glab auth status`), { code });
    const timedOut: ExecFileException = Object.assign(
      new Error("Command failed: glab auth status"),
      { killed: true, signal: "SIGTERM" as const, code: null },
    );
    const spawnFailed: ExecFileException = Object.assign(
      new Error("spawn glab EAGAIN"),
      { code: "EAGAIN" },
    );
    const missing: ExecFileException = Object.assign(
      new Error("spawn glab ENOENT"),
      { code: "ENOENT" },
    );

    expect(readAuthStatus(null, "", loggedIn)).toEqual(["gitlab.com"]);
    // glab exits 1 when any configured host fails; the text still decides.
    expect(readAuthStatus(exited(1), "", loggedIn)).toEqual(["gitlab.com"]);
    expect(readAuthStatus(exited(1), "", "x gitlab.com: 401")).toEqual([]);
    // A killed or never-spawned run says nothing about auth: it must not
    // read as "no host", which latches needs-configuration until reload.
    for (const error of [timedOut, spawnFailed, missing]) {
      expect(() => readAuthStatus(error, "", "")).toThrow("did not finish");
    }

    // Probing for the binary: only a missing or broken candidate rules it out.
    expect(isUnfinishedRun(timedOut)).toBe(true);
    expect(isUnfinishedRun(spawnFailed)).toBe(true);
    expect(isUnfinishedRun(missing)).toBe(false);
    expect(isUnfinishedRun(exited(2))).toBe(false);
  });
});
