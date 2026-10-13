// GitLab reads and writes beyond the sync: viewer identity, members, labels,
// issue and merge-request detail, and the issue/note mutations. All of it is
// GraphQL. Viewer, members, and labels are cached in memory so the filter
// chips and pickers don't hit the network on every render.
import type { MergeRequestDetail, Note } from "./contract";
import { needsConfiguration, GLAB_HINT, type GitlabGraphql } from "./glab";
import {
  CREATE_ISSUE_MUTATION,
  CREATE_NOTE_MUTATION,
  ISSUE_DETAIL_QUERY,
  ISSUE_QUERY,
  LABELS_QUERY,
  MEMBERS_QUERY,
  MERGE_REQUEST_DETAIL_QUERY,
  MERGE_REQUEST_QUERY,
  MERGE_REQUEST_SECTION_QUERIES,
  SET_ASSIGNEES_MUTATION,
  UPDATE_ISSUE_MUTATION,
  VIEWER_QUERY,
  itemQuery,
} from "./graphql/documents";
import {
  createdIssueSchema,
  issueDetailResultSchema,
  itemDetailResultSchema,
  itemIdResultSchema,
  itemOf,
  labelsResultSchema,
  membersResultSchema,
  mergeRequestDetailResultSchema,
  mutationPayload,
  nodesOf,
  updatedIssueSchema,
  viewerResultSchema,
  type GitlabItemNode,
  type LabelsConnection,
} from "./graphql/payloads";
import { labelTitles, toNotes, usernames } from "./items";
import { toMergeRequestDetail } from "./merge-request";
import { parseProjectRef } from "./project-ref";

/** Label pages to walk before giving up on a project's label list. */
const MAX_LABEL_PAGES = 10;
const VIEWER_TTL_MS = 60 * 60_000;
const PROJECT_DATA_TTL_MS = 10 * 60_000;

export interface IssueDetail {
  project: string;
  iid: number;
  title: string;
  state: string;
  author: string;
  body: string;
  labels: string[];
  assignees: string[];
  url: string;
  updatedAt: string;
  notes: Note[];
}

export interface GitlabApi {
  /** The glab user on `host`, else on the first authenticated host. */
  viewer(host?: string): Promise<string>;
  /** Usernames of the project's direct and inherited members. */
  members(project: string): Promise<string[]>;
  /** Titles of the project's labels, its ancestor groups' included. */
  labels(project: string): Promise<string[]>;
  /** Closes or reopens an issue; resolves to the state GitLab applied. */
  setIssueState(
    project: string,
    iid: number,
    state: "open" | "closed",
  ): Promise<string>;
  /** Sets the exact assignee list; resolves to the list GitLab applied. */
  setAssignees(project: string, iid: number, names: string[]): Promise<string[]>;
  /** Sets the exact label list; resolves to the list GitLab applied. */
  setLabels(project: string, iid: number, titles: string[]): Promise<string[]>;
  getIssue(project: string, iid: number): Promise<IssueDetail>;
  getMergeRequest(project: string, iid: number): Promise<MergeRequestDetail>;
  /** One issue or merge request without comments, or null when missing. */
  getItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): Promise<GitlabItemNode | null>;
  addNote(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    body: string,
  ): Promise<void>;
  createIssue(
    project: string,
    title: string,
    body: string,
  ): Promise<{ iid: number | null; url: string }>;
}

export function createGitlabApi(options: {
  graphql: GitlabGraphql;
  /** The host `viewer()` asks when no host is given. */
  defaultHost: () => string | undefined;
  warn: (message: string) => void;
}): GitlabApi {
  const { graphql, defaultHost, warn } = options;
  const viewerCache = new Map<string, { username: string; fetchedAt: number }>();
  const membersCache = new Map<string, { members: string[]; fetchedAt: number }>();
  const labelsCache = new Map<
    string,
    { labels: Array<{ id: string; title: string }>; fetchedAt: number }
  >();

  const itemVariables = (project: string, iid: number) => {
    const { host, path } = parseProjectRef(project);
    return { host, variables: { path, iid: String(iid) } };
  };

  /**
   * Project and ancestor-group labels with their global ids, which is what
   * GraphQL mutations take. Group labels can repeat a project label's title;
   * the first one GitLab returns wins.
   */
  async function projectLabels(
    project: string,
    force = false,
  ): Promise<Array<{ id: string; title: string }>> {
    const cached = labelsCache.get(project);
    if (
      !force &&
      cached !== undefined &&
      Date.now() - cached.fetchedAt < PROJECT_DATA_TTL_MS
    ) {
      return cached.labels;
    }
    const { host, path } = parseProjectRef(project);
    const byTitle = new Map<string, { id: string; title: string }>();
    let after: string | null = null;
    for (let page = 0; page < MAX_LABEL_PAGES; page += 1) {
      const connection: LabelsConnection = labelsResultSchema.parse(
        await graphql(host, LABELS_QUERY, { path, after }),
      ).project?.labels;
      for (const label of nodesOf(connection)) {
        const title = label.title.trim();
        if (title.length > 0 && label.id.length > 0 && !byTitle.has(title)) {
          byTitle.set(title, { id: label.id, title });
        }
      }
      if (connection?.pageInfo.hasNextPage !== true) break;
      after = connection.pageInfo.endCursor;
      if (after === null) break;
    }
    const labels = [...byTitle.values()].sort((a, b) =>
      a.title.localeCompare(b.title),
    );
    labelsCache.set(project, { labels, fetchedAt: Date.now() });
    return labels;
  }

  /** Label titles → global ids, refreshing once for a label created lately. */
  async function resolveLabelIds(
    project: string,
    titles: readonly string[],
  ): Promise<string[]> {
    if (titles.length === 0) return [];
    let labels = await projectLabels(project);
    if (titles.some((title) => !labels.some((label) => label.title === title))) {
      labels = await projectLabels(project, true);
    }
    return titles.map((title) => {
      const found = labels.find((label) => label.title === title);
      if (found === undefined) throw new Error(`unknown GitLab label "${title}"`);
      return found.id;
    });
  }

  return {
    async viewer(host) {
      const resolvedHost = host ?? defaultHost();
      if (resolvedHost === undefined) {
        throw needsConfiguration(`No authenticated GitLab host. ${GLAB_HINT}`);
      }
      const cached = viewerCache.get(resolvedHost);
      if (cached !== undefined && Date.now() - cached.fetchedAt < VIEWER_TTL_MS) {
        return cached.username;
      }
      const { currentUser } = viewerResultSchema.parse(
        await graphql(resolvedHost, VIEWER_QUERY),
      );
      const username = currentUser?.username ?? "";
      if (username.length === 0) {
        throw new Error(`could not resolve the glab user on ${resolvedHost}`);
      }
      viewerCache.set(resolvedHost, { username, fetchedAt: Date.now() });
      return username;
    },

    async members(project) {
      const cached = membersCache.get(project);
      if (
        cached !== undefined &&
        Date.now() - cached.fetchedAt < PROJECT_DATA_TTL_MS
      ) {
        return cached.members;
      }
      const { host, path } = parseProjectRef(project);
      const result = membersResultSchema.parse(
        await graphql(host, MEMBERS_QUERY, { path }),
      ).project;
      const members = nodesOf(result?.projectMembers)
        .map((member) => member.user?.username ?? "")
        .filter((name) => name.length > 0);
      membersCache.set(project, { members, fetchedAt: Date.now() });
      return members;
    },

    async labels(project) {
      return (await projectLabels(project)).map((label) => label.title);
    },

    async setIssueState(project, iid, state) {
      const { host, path } = parseProjectRef(project);
      const payload = updatedIssueSchema.parse(
        mutationPayload(
          await graphql(host, UPDATE_ISSUE_MUTATION, {
            input: {
              projectPath: path,
              iid: String(iid),
              stateEvent: state === "closed" ? "CLOSE" : "REOPEN",
            },
          }),
          "updateIssue",
        ),
      );
      return payload.issue?.state ?? (state === "closed" ? "closed" : "opened");
    },

    async setAssignees(project, iid, names) {
      const { host, path } = parseProjectRef(project);
      const payload = updatedIssueSchema.parse(
        mutationPayload(
          await graphql(host, SET_ASSIGNEES_MUTATION, {
            input: {
              projectPath: path,
              iid: String(iid),
              // REPLACE with an empty list clears the assignees.
              assigneeUsernames: [...new Set(names)],
              operationMode: "REPLACE",
            },
          }),
          "issueSetAssignees",
        ),
      );
      return usernames(payload.issue?.assignees);
    },

    async setLabels(project, iid, titles) {
      const next = [
        ...new Set(titles.map((title) => title.trim()).filter(Boolean)),
      ];
      const { host, path } = parseProjectRef(project);
      const labelIds = await resolveLabelIds(project, next);
      const payload = updatedIssueSchema.parse(
        mutationPayload(
          await graphql(host, UPDATE_ISSUE_MUTATION, {
            input: { projectPath: path, iid: String(iid), labelIds },
          }),
          "updateIssue",
        ),
      );
      return labelTitles(payload.issue?.labels);
    },

    async getIssue(project, iid) {
      const { host, variables } = itemVariables(project, iid);
      const detail = issueDetailResultSchema.parse(
        await graphql(host, ISSUE_DETAIL_QUERY, variables),
      ).project?.item;
      if (detail == null) throw new Error(`GitLab ${project}#${iid} not found`);
      return {
        project,
        iid,
        title: detail.title,
        state: detail.state,
        author: detail.author?.username ?? "",
        body: detail.description,
        labels: labelTitles(detail.labels),
        assignees: usernames(detail.assignees),
        url: detail.webUrl,
        updatedAt: detail.updatedAt,
        notes: toNotes(nodesOf(detail.notes)),
      };
    },

    /**
     * Approvals, discussions, diffs, and jobs are optional on any given
     * instance or plan, so each is its own request and a failure there
     * degrades that section instead of the whole view.
     */
    async getMergeRequest(project, iid) {
      const { host, variables } = itemVariables(project, iid);
      const optional = async (
        section: keyof typeof MERGE_REQUEST_SECTION_QUERIES,
      ): Promise<unknown> => {
        try {
          return itemOf(
            await graphql(host, MERGE_REQUEST_SECTION_QUERIES[section], variables),
          );
        } catch (error) {
          warn(
            `optional merge request ${section} for ${project}!${iid} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      };
      const [detailRaw, discussions, diffs, approvals, jobs] =
        await Promise.all([
          graphql(host, MERGE_REQUEST_DETAIL_QUERY, variables),
          optional("discussions"),
          optional("diffs"),
          optional("approvals"),
          optional("jobs"),
        ]);
      const detail = mergeRequestDetailResultSchema.parse(detailRaw).project
        ?.item;
      if (detail == null) throw new Error(`GitLab ${project}!${iid} not found`);
      return toMergeRequestDetail(project, iid, {
        detail,
        discussions,
        diffs,
        approvals,
        jobs,
      });
    },

    async getItem(kind, project, iid) {
      const { host, variables } = itemVariables(project, iid);
      return (
        itemDetailResultSchema.parse(
          await graphql(
            host,
            kind === "mr" ? MERGE_REQUEST_QUERY : ISSUE_QUERY,
            variables,
          ),
        ).project?.item ?? null
      );
    },

    async addNote(kind, project, iid, body) {
      // createNote takes the item's global id, not its iid.
      const { host, variables } = itemVariables(project, iid);
      const item = itemIdResultSchema.parse(
        await graphql(host, itemQuery(kind, "id"), variables),
      ).project?.item;
      if (item == null) {
        const marker = kind === "mr" ? "!" : "#";
        throw new Error(`GitLab ${project}${marker}${iid} not found`);
      }
      mutationPayload(
        await graphql(host, CREATE_NOTE_MUTATION, {
          input: { noteableId: item.id, body },
        }),
        "createNote",
      );
    },

    async createIssue(project, title, body) {
      const { host, path } = parseProjectRef(project);
      const { issue } = createdIssueSchema.parse(
        mutationPayload(
          await graphql(host, CREATE_ISSUE_MUTATION, {
            input: { projectPath: path, title, description: body },
          }),
          "createIssue",
        ),
      );
      return { iid: issue?.iid ?? null, url: issue?.webUrl ?? "" };
    },
  };
}
