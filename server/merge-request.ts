// A merge request's detail view, assembled from the GraphQL sections
// gitlab-api fetches: overview, pipeline jobs, approvals, inline discussion
// threads, and per-file diffs.
import { z } from "zod";
import type { MergeRequestDetail, Note } from "./contract";
import {
  gitlabApprovalsSchema,
  gitlabMergeRequestDetailSchema,
  mergeRequestDiffsSchema,
  mergeRequestDiscussionsSchema,
  mergeRequestJobsSchema,
  nodesOf,
} from "./graphql/payloads";
import { labelTitles, toNotes, usernames } from "./items";

/** Per-file diffs above this size stay on GitLab; the panel links out. */
const MAX_PATCH_BYTES = 20_000;

/**
 * +/- line counts of a unified diff. GitLab ships the diff text per file but
 * no per-file counts, so the panel's numbers come from here.
 */
export function countDiffLines(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** GitLab job status → one traffic-light value for the panel. */
export function classifyJobStatus(
  rawStatus: string,
): "success" | "failure" | "pending" | "neutral" {
  switch (rawStatus) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "preparing":
    case "scheduled":
    case "waiting_for_resource":
      return "pending";
    default:
      // canceled, skipped, manual, and anything GitLab adds later.
      return "neutral";
  }
}

/**
 * An absolute URL for a GraphQL `webPath`/`path`. Those paths already carry
 * any subfolder the instance is served under, so only the origin of a known
 * web URL is needed.
 */
export function webUrlFor(path: string, knownWebUrl: string): string {
  if (path.length === 0) return "";
  try {
    return new URL(path, knownWebUrl).toString();
  } catch {
    return "";
  }
}

/**
 * The raw sections of one merge request. `detail` is required; the others
 * are optional on a given instance or plan and stay undefined when their
 * request failed, which empties that section only.
 */
export interface MergeRequestSections {
  detail: z.infer<typeof gitlabMergeRequestDetailSchema>;
  discussions: unknown;
  diffs: unknown;
  approvals: unknown;
  jobs: unknown;
}

export function toMergeRequestDetail(
  project: string,
  iid: number,
  sections: MergeRequestSections,
): MergeRequestDetail {
  const { detail } = sections;

  const jobs = nodesOf(
    mergeRequestJobsSchema.parse(sections.jobs).headPipeline?.jobs,
  ).map((job) => {
    const rawStatus = job.status.toLowerCase();
    return {
      name: job.name,
      status: classifyJobStatus(rawStatus),
      rawStatus,
      url: webUrlFor(job.webPath, detail.webUrl),
    };
  });

  // A discussion whose notes carry a diff position is an inline review
  // thread; everything else already showed up in the conversation notes.
  const discussions: Array<{
    path: string;
    line: number | null;
    resolved: boolean;
    notes: Note[];
  }> = [];
  for (const discussion of nodesOf(
    mergeRequestDiscussionsSchema.parse(sections.discussions).discussions,
  )) {
    const discussionNotes = nodesOf(discussion.notes);
    const position = discussionNotes.find(
      (note) => note.position != null,
    )?.position;
    if (position == null) continue;
    const notes = toNotes(discussionNotes);
    if (notes.length === 0) continue;
    discussions.push({
      path: position.newPath ?? position.oldPath ?? "",
      line: position.newLine ?? position.oldLine,
      resolved: !discussion.resolvable || discussion.resolved,
      notes,
    });
  }

  // Per-file counts come from diffStats; the diff text, when this instance
  // serves it, from diffs. Without diffs the file list still shows, with
  // every patch left on GitLab.
  const statsByPath = new Map(
    detail.diffStats.map((stat) => [stat.path, stat]),
  );
  const diffs = mergeRequestDiffsSchema.parse(sections.diffs).diffs;
  const files =
    diffs != null
      ? diffs.nodes.map((file) => {
          const path = file.newPath ?? file.oldPath ?? "";
          const counts = statsByPath.get(path) ?? countDiffLines(file.diff);
          return {
            path,
            status: file.newFile
              ? "added"
              : file.deletedFile
                ? "deleted"
                : file.renamedFile
                  ? "renamed"
                  : "modified",
            additions: counts.additions,
            deletions: counts.deletions,
            // Very large diffs stay on GitLab — the panel links out instead.
            patch:
              file.diff.length > 0 && file.diff.length <= MAX_PATCH_BYTES
                ? file.diff
                : null,
          };
        })
      : detail.diffStats.map((stat) => ({
          path: stat.path,
          status: "modified",
          additions: stat.additions,
          deletions: stat.deletions,
          patch: null,
        }));
  const summary = detail.diffStatsSummary;
  const approvals = gitlabApprovalsSchema.parse(sections.approvals);

  return {
    project,
    iid,
    title: detail.title,
    state: detail.state,
    draft: detail.draft,
    author: detail.author?.username ?? "",
    body: detail.description,
    url: detail.webUrl,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    sourceBranch: detail.sourceBranch,
    targetBranch: detail.targetBranch,
    additions:
      summary?.additions ??
      files.reduce((sum, file) => sum + file.additions, 0),
    deletions:
      summary?.deletions ??
      files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: summary?.fileCount ?? files.length,
    filesTruncated: diffs?.pageInfo.hasNextPage ?? false,
    labels: labelTitles(detail.labels),
    assignees: usernames(detail.assignees),
    reviewers: usernames(detail.reviewers),
    // GraphQL enums are upper case; the panel expects snake case.
    mergeStatus: (detail.detailedMergeStatus ?? "").toLowerCase(),
    hasConflicts: detail.conflicts,
    approvalsRequired: approvals.approvalsRequired,
    approvalsLeft: approvals.approvalsLeft,
    approvedBy: usernames(approvals.approvedBy),
    pipeline:
      detail.headPipeline == null
        ? null
        : {
            status: detail.headPipeline.status.toLowerCase(),
            url: webUrlFor(detail.headPipeline.path, detail.webUrl),
          },
    jobs,
    notes: toNotes(nodesOf(detail.notes)),
    discussions,
    files,
  };
}
