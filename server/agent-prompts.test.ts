import { describe, expect, it } from "vitest";
import { graphqlReadCommands } from "./agent-prompts";

describe("agent prompts", () => {
  it("hands agents GraphQL read commands, never REST subcommands", () => {
    const [issue] = graphqlReadCommands("issue", "gitlab.example.dev/group/sub/app", 7);
    expect(issue).toBe(
      "glab api graphql --hostname gitlab.example.dev -f path=group/sub/app -f iid=7 " +
        "-f query='query($path: ID!, $iid: String!) { project(fullPath: $path) { " +
        "issue(iid: $iid) { title state webUrl description notes(first: 100) " +
        "{ nodes { system body createdAt author { username } } } } } }'",
    );
    const mr = graphqlReadCommands("mr", "gitlab.com/group/app", 12);
    expect(mr).toHaveLength(2);
    expect(mr[1]).toContain("mergeRequest(iid: $iid) { diffs(first: 100)");
    for (const command of mr) expect(command).toMatch(/^glab api graphql /);
  });
});
