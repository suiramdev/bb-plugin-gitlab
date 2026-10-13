import { describe, expect, it } from "vitest";
import { validateGitlabCliArgs } from "./cli";

describe("bb gitlab CLI", () => {
  it("rejects CLI arguments that would otherwise broaden a project query", () => {
    expect(validateGitlabCliArgs(["issues", "gitlab.com/group/sub/app"])).toBeNull();
    expect(validateGitlabCliArgs(["issues", "not a project"])).toContain(
      "expected host/group/project",
    );
    expect(
      validateGitlabCliArgs(["mrs", "gitlab.com/group/app", "extra"]),
    ).toContain("Unexpected argument");
    expect(validateGitlabCliArgs(["projects", "--json"])).toContain(
      "does not accept arguments",
    );
  });
});
