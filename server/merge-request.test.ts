import { describe, expect, it } from "vitest";
import { gitlabMergeRequestDetailSchema } from "./graphql/payloads";
import {
  classifyJobStatus,
  countDiffLines,
  toMergeRequestDetail,
  webUrlFor,
} from "./merge-request";

const detail = gitlabMergeRequestDetailSchema.parse({
  iid: "12",
  title: "Add geometries",
  state: "opened",
  webUrl: "https://code.example.dev/gitlab/group/app/-/merge_requests/12",
  detailedMergeStatus: "NEED_REBASE",
  diffStatsSummary: { additions: 3, deletions: 1, fileCount: 2 },
  diffStats: [
    { path: "src/a.ts", additions: 2, deletions: 1 },
    { path: "src/b.ts", additions: 1, deletions: 0 },
  ],
  headPipeline: { status: "FAILED", path: "/gitlab/group/app/-/pipelines/5" },
  notes: { nodes: [{ body: "added 1 commit", system: true }, { body: "LGTM" }] },
});

describe("merge request detail", () => {
  it("counts diff lines without charging the +++/--- headers", () => {
    const diff = [
      "@@ -1,4 +1,5 @@",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      " context",
      "-removed",
      "+added one",
      "+added two",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("maps GitLab job statuses onto the panel's traffic light", () => {
    expect(classifyJobStatus("success")).toBe("success");
    expect(classifyJobStatus("failed")).toBe("failure");
    expect(classifyJobStatus("running")).toBe("pending");
    expect(classifyJobStatus("waiting_for_resource")).toBe("pending");
    // A manual or skipped job is not a failure — it is simply not a signal.
    expect(classifyJobStatus("manual")).toBe("neutral");
    expect(classifyJobStatus("skipped")).toBe("neutral");
  });

  it("resolves web paths against the instance, keeping its subfolder", () => {
    expect(
      webUrlFor(
        "/gitlab/group/app/-/jobs/9",
        "https://code.example.dev/gitlab/group/app/-/merge_requests/3",
      ),
    ).toBe("https://code.example.dev/gitlab/group/app/-/jobs/9");
    expect(webUrlFor("", "https://gitlab.com/g/a/-/merge_requests/1")).toBe("");
    expect(webUrlFor("/g/a/-/jobs/1", "")).toBe("");
  });

  it("assembles the panel's merge request from GraphQL sections", () => {
    const mr = toMergeRequestDetail("code.example.dev/group/app", 12, {
      detail,
      discussions: {
        discussions: {
          nodes: [
            {
              resolvable: true,
              resolved: false,
              notes: {
                nodes: [
                  {
                    body: "Rename this",
                    author: { username: "tanuki" },
                    position: { newPath: "src/a.ts", newLine: 4 },
                  },
                ],
              },
            },
            // No diff position: already shown among the conversation notes.
            { notes: { nodes: [{ body: "General" }] } },
          ],
        },
      },
      diffs: {
        diffs: {
          pageInfo: { hasNextPage: true },
          nodes: [
            { newPath: "src/a.ts", newFile: "false", diff: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
            { newPath: "src/b.ts", newFile: "true", diff: "" },
          ],
        },
      },
      approvals: { approvalsRequired: 1, approvalsLeft: 1, approvedBy: { nodes: [] } },
      jobs: {
        headPipeline: {
          jobs: { nodes: [{ name: "test", status: "FAILED", webPath: "/gitlab/group/app/-/jobs/9" }] },
        },
      },
    });
    expect(mr).toMatchObject({
      mergeStatus: "need_rebase",
      additions: 3,
      deletions: 1,
      changedFiles: 2,
      filesTruncated: true,
      pipeline: {
        status: "failed",
        url: "https://code.example.dev/gitlab/group/app/-/pipelines/5",
      },
      jobs: [
        {
          name: "test",
          status: "failure",
          rawStatus: "failed",
          url: "https://code.example.dev/gitlab/group/app/-/jobs/9",
        },
      ],
      notes: [{ body: "LGTM" }],
      discussions: [{ path: "src/a.ts", line: 4, resolved: false }],
    });
    expect(mr.files).toEqual([
      // Counts come from diffStats; GraphQL sends the flags as strings.
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
      { path: "src/b.ts", status: "added", additions: 1, deletions: 0, patch: null },
    ]);
  });

  it("keeps the file list from diffStats when the diffs section failed", () => {
    const mr = toMergeRequestDetail("code.example.dev/group/app", 12, {
      detail,
      discussions: undefined,
      diffs: undefined,
      approvals: undefined,
      jobs: undefined,
    });
    expect(mr.files.map((file) => [file.path, file.patch])).toEqual([
      ["src/a.ts", null],
      ["src/b.ts", null],
    ]);
    expect(mr).toMatchObject({
      filesTruncated: false,
      jobs: [],
      discussions: [],
      approvalsRequired: 0,
    });
  });
});
