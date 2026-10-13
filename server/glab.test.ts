import { describe, expect, it } from "vitest";
import { parseAuthenticatedHosts } from "./glab";

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
