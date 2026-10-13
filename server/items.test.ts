import { describe, expect, it } from "vitest";
import { fetchProjectItems, toItems } from "./items";

describe("GitLab item parsing and sync", () => {
  it("normalizes issue and merge-request nodes, dropping unusable ones", () => {
    const connection = {
      nodes: [
        {
          iid: "7",
          title: "Fix the flaky spec",
          state: "opened",
          draft: true,
          author: { username: "tanuki" },
          labels: { nodes: [{ title: "bug" }, { title: "ci" }] },
          assignees: { nodes: [{ username: "mensahs" }, { username: "" }] },
          webUrl: "https://gitlab.com/group/app/-/merge_requests/7",
          description: "It fails once per week.",
          updatedAt: "2026-08-14T12:29:03Z",
        },
        // No iid: GitLab cannot address it, so neither can the cache.
        { title: "orphan" },
        null,
      ],
    };
    expect(toItems(connection, "gitlab.com/group/app", "mr")).toEqual([
      {
        project: "gitlab.com/group/app",
        iid: 7,
        kind: "mr",
        title: "Fix the flaky spec",
        state: "opened",
        draft: true,
        author: "tanuki",
        labels: ["bug", "ci"],
        assignees: ["mensahs"],
        url: "https://gitlab.com/group/app/-/merge_requests/7",
        body: "It fails once per week.",
        updatedAt: "2026-08-14T12:29:03Z",
      },
    ]);
  });

  it("falls back to empty fields rather than failing a whole list", () => {
    const items = toItems(
      { nodes: [{ iid: "1", description: null, labels: null }] },
      "gitlab.com/g/a",
      "issue",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "", state: "opened", body: "", labels: [], author: "" });
    expect(toItems(null, "gitlab.com/g/a", "issue")).toEqual([]);
    expect(toItems({ message: "404 Not found" }, "gitlab.com/g/a", "issue")).toEqual([]);
  });

  it("syncs a project in one query and keeps merge requests when issues are disabled", async () => {
    const calls: Array<{ host: string; query: string; variables: unknown }> = [];
    const items = await fetchProjectItems(async (host, query, variables) => {
      calls.push({ host, query, variables });
      return {
        project: {
          // Issues disabled: GitLab returns no issue connection.
          openIssues: null,
          closedIssues: null,
          openMergeRequests: {
            nodes: [
              {
                iid: "12",
                title: "Add geometries",
                state: "opened",
                draft: false,
                author: { username: "mensahs" },
                webUrl: "https://gitlab.example.dev/group/sub/app/-/merge_requests/12",
                updatedAt: "2026-08-14T12:29:03Z",
              },
            ],
          },
          closedMergeRequests: { nodes: [] },
          mergedMergeRequests: { nodes: [] },
        },
      };
    }, "gitlab.example.dev/group/sub/app");

    // One request, on the project's host, with the full path as a variable.
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe("gitlab.example.dev");
    expect(calls[0].variables).toEqual({ path: "group/sub/app" });
    expect(calls[0].query).toContain("project(fullPath: $path)");
    expect(items).toEqual([
      {
        project: "gitlab.example.dev/group/sub/app",
        iid: 12,
        kind: "mr",
        title: "Add geometries",
        state: "opened",
        draft: false,
        author: "mensahs",
        labels: [],
        assignees: [],
        url: "https://gitlab.example.dev/group/sub/app/-/merge_requests/12",
        body: "",
        updatedAt: "2026-08-14T12:29:03Z",
      },
    ]);
  });

  it("caches nothing for a project GitLab cannot find", async () => {
    await expect(
      fetchProjectItems(async () => ({ project: null }), "gitlab.com/gone/app"),
    ).resolves.toEqual([]);
  });

  it("lets a genuine failure abort the sync instead of caching an empty project", async () => {
    await expect(
      fetchProjectItems(async () => {
        throw new Error("glab api graphql failed: 500 Internal Server Error");
      }, "gitlab.com/group/app"),
    ).rejects.toThrow("500");
  });
});
