// Issues and merge requests as the plugin caches them, parsed from GraphQL
// item nodes, and the one-query-per-project sync that fills the cache.
import { z } from "zod";
import type { Note } from "./contract";
import type { GitlabGraphql } from "./glab";
import { SYNC_QUERY } from "./graphql/documents";
import {
  connectionOf,
  gitlabItemNodeSchema,
  nodesOf,
  projectResultOf,
  type GitlabItemNode,
  type GitlabNoteNode,
  type GitlabUserNode,
} from "./graphql/payloads";
import { parseProjectRef } from "./project-ref";

export interface CachedItem {
  project: string;
  iid: number;
  kind: "issue" | "mr";
  title: string;
  state: string;
  draft: boolean;
  author: string;
  labels: string[];
  assignees: string[];
  url: string;
  body: string;
  updatedAt: string;
}

export function usernames(
  connection: { nodes: Array<GitlabUserNode | null> } | null | undefined,
): string[] {
  return nodesOf(connection)
    .map((node) => node.username)
    .filter((name) => name.length > 0);
}

export function labelTitles(
  connection: { nodes: Array<{ title: string } | null> } | null | undefined,
): string[] {
  return nodesOf(connection)
    .map((node) => node.title)
    .filter((title) => title.length > 0);
}

/** Human notes of a note list — GitLab's activity feed is in there too. */
export function toNotes(notes: readonly GitlabNoteNode[]): Note[] {
  return notes
    .filter((note) => !note.system && note.body.trim().length > 0)
    .map((note) => ({
      author: note.author?.username ?? "",
      body: note.body,
      createdAt: note.createdAt,
    }));
}

function toItem(
  node: GitlabItemNode,
  project: string,
  kind: "issue" | "mr",
): CachedItem {
  return {
    project,
    iid: node.iid,
    kind,
    title: node.title,
    state: node.state,
    draft: node.draft,
    author: node.author?.username ?? "",
    labels: labelTitles(node.labels),
    assignees: usernames(node.assignees),
    url: node.webUrl,
    body: node.description,
    updatedAt: node.updatedAt,
  };
}

const gitlabItemConnectionSchema = connectionOf(gitlabItemNodeSchema);

/** Parses an issue/MR connection, dropping nodes it cannot read. */
export function toItems(
  connection: unknown,
  project: string,
  kind: "issue" | "mr",
): CachedItem[] {
  return nodesOf(gitlabItemConnectionSchema.parse(connection)).map((node) =>
    toItem(node, project, kind),
  );
}

const gitlabSyncResultSchema = projectResultOf(
  z.looseObject({
    openIssues: z.unknown(),
    closedIssues: z.unknown(),
    openMergeRequests: z.unknown(),
    closedMergeRequests: z.unknown(),
    mergedMergeRequests: z.unknown(),
  }),
);

/**
 * Open items plus a page of recently-closed (and merged) ones, so the Closed
 * filter has something to show without a live glab call per view. One
 * GraphQL request covers all five lists. A project with issues disabled
 * returns no issue connection and still contributes its merge requests; a
 * project GitLab cannot find contributes nothing.
 */
export async function fetchProjectItems(
  api: GitlabGraphql,
  project: string,
): Promise<CachedItem[]> {
  const { host, path } = parseProjectRef(project);
  const result = gitlabSyncResultSchema.parse(
    await api(host, SYNC_QUERY, { path }),
  ).project;
  if (result == null) return [];
  return [
    ...toItems(result.openIssues, project, "issue"),
    ...toItems(result.closedIssues, project, "issue"),
    ...toItems(result.openMergeRequests, project, "mr"),
    ...toItems(result.closedMergeRequests, project, "mr"),
    ...toItems(result.mergedMergeRequests, project, "mr"),
  ];
}
