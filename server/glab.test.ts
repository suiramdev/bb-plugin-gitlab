import { describe, expect, it } from "vitest";
import { graphqlArgs, parseAuthenticatedHosts } from "./glab";

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
});
