// bb-plugin-gitlab — GitLab issues & merge requests inside BB.
//
// Auth rides on the GitLab CLI: every host `glab auth status` reports as
// logged in is a host this plugin can reach, so self-managed instances work
// without extra configuration. Projects are discovered from each BB project's
// git remote (kept when its host is one of those authenticated hosts) plus an
// optional extraProjects setting. A background service syncs open +
// recently-closed issues/MRs into the plugin's SQLite cache; the frontend
// panel and mention providers read that cache, while mutations (note, create,
// close/reopen, assign, label) and detail views go straight to GitLab. Every
// GitLab request is GraphQL, sent through `glab api graphql`.
//
// A project is addressed by its host-qualified ref — "gitlab.com/group/sub/app"
// — because a GitLab path has any number of namespace segments and the same
// path can exist on two instances.
import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SYNC_INTERVAL_MS = 5 * 60_000;
const ISSUE_PAGE = 100;
const CLOSED_ISSUE_PAGE = 50;
const MR_PAGE = 50;
const CLOSED_MR_PAGE = 30;
/** One page of per-file diffs; a bigger merge request reports truncation. */
const DIFF_PAGE = 100;
/** Per-file diffs above this size stay on GitLab; the panel links out. */
const MAX_PATCH_BYTES = 20_000;

const GLAB_HINT =
  "Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run " +
  "`glab auth login`, then `bb plugin reload gitlab`.";

/**
 * "host/group/sub/project" — the host glab knows the instance by, then a path
 * of 1+ namespace segments. No port and no scheme: `glab --hostname` accepts a
 * bare hostname only, and everything else about how an instance is reached
 * (port, subfolder, http, alternate SSH host, custom CA) lives in that host's
 * glab config. Underscores appear in intranet hostnames, which glab accepts.
 */
const PROJECT_REF_PATTERN =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// ---------------------------------------------------------------------------
// The rpc contract: what the frontend panel may ask for.
// ---------------------------------------------------------------------------
const projectRefSchema = z.string().regex(PROJECT_REF_PATTERN);
const iidSchema = z.number().int().positive();
const itemInputSchema = z
  .object({ project: projectRefSchema, iid: iidSchema })
  .strict();
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const projectInfoSchema = z
  .object({
    project: projectRefSchema,
    host: z.string().min(1),
    path: z.string().min(1),
    bbProjectId: z.string().nullable(),
  })
  .strict();
const itemSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    kind: z.enum(["issue", "mr"]),
    title: z.string(),
    /** GitLab-native: "opened" | "closed" | "merged" | "locked". */
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z
  .object({
    projects: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const noteSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();
const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "mr"]),
    project: projectRefSchema,
    iid: iidSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
const mergeRequestSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    title: z.string(),
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    /** GitLab's totals for the whole merge request, even when files is partial. */
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** GitLab's own total, which can exceed files.length. */
    changedFiles: z.number().int().nonnegative(),
    /** True when the diff list stopped at the page limit, so files is partial. */
    filesTruncated: z.boolean(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewers: z.array(z.string()),
    /** GitLab's detailedMergeStatus lowercased, e.g. "mergeable", "need_rebase". */
    mergeStatus: z.string(),
    hasConflicts: z.boolean(),
    approvalsRequired: z.number().int().nonnegative(),
    approvalsLeft: z.number().int().nonnegative(),
    approvedBy: z.array(z.string()),
    pipeline: z
      .object({ status: z.string(), url: z.string() })
      .strict()
      .nullable(),
    jobs: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["success", "failure", "pending", "neutral"]),
          rawStatus: z.string(),
          url: z.string(),
        })
        .strict(),
    ),
    notes: z.array(noteSchema),
    discussions: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          resolved: z.boolean(),
          notes: z.array(noteSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const gitlabRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        glabOk: z.boolean(),
        glabError: z.string().nullable(),
        hosts: z.array(z.string()),
        projects: z.array(projectInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "mr"]).optional(),
        project: projectRefSchema.optional(),
        state: z.enum(["open", "closed"]).optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ username: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  projectLabels: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ labels: z.array(z.string().min(1)) }).strict(),
  },
  setIssueState: {
    input: itemInputSchema
      .extend({ state: z.enum(["open", "closed"]) })
      .strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema
      .extend({ assignees: z.array(z.string().min(1)) })
      .strict(),
    output: z
      .object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) })
      .strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z
      .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
      .strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            project: projectRefSchema,
            iid: iidSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            notes: z.array(noteSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getMergeRequest: {
    input: itemInputSchema,
    output: z.object({ mergeRequest: mergeRequestSchema }).strict(),
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  commentMergeRequest: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        project: projectRefSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z.object({ iid: iidSchema.nullable(), url: z.string() }).strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  mergeRequestForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ mergeRequest: itemInputSchema.nullable() }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z
      .object({ links: z.record(z.string(), z.array(threadLinkSchema)) })
      .strict(),
  },
});

// ---------------------------------------------------------------------------
// GitLab GraphQL payloads. These come off the network, so every field is
// parsed with a fallback: one odd node must never take down a list or a
// detail view.
// ---------------------------------------------------------------------------

/** A GraphQL connection's nodes, with unreadable nodes kept as null. */
function connectionOf<T extends z.ZodType>(node: T) {
  return z
    .looseObject({ nodes: z.array(node.nullable().catch(null)).catch([]) })
    .nullish()
    .catch(null);
}

/** The readable nodes of a connection parsed by connectionOf. */
function nodesOf<T>(connection: { nodes: Array<T | null> } | null | undefined): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node !== null);
}

/** GraphQL sends some booleans (the Diff flags) as "true"/"false" strings. */
const looseBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
  .catch(false);

const gitlabUserNodeSchema = z.looseObject({
  username: z.string().catch(""),
});
const gitlabLabelNodeSchema = z.looseObject({
  id: z.string().catch(""),
  title: z.string().catch(""),
});
const gitlabItemNodeSchema = z.looseObject({
  // GraphQL types iid as a string.
  iid: z.coerce.number().int().positive(),
  title: z.string().catch(""),
  state: z.string().catch("opened"),
  draft: z.boolean().catch(false),
  author: gitlabUserNodeSchema.nullish().catch(null),
  labels: connectionOf(gitlabLabelNodeSchema),
  assignees: connectionOf(gitlabUserNodeSchema),
  webUrl: z.string().catch(""),
  description: z.string().catch(""),
  updatedAt: z.string().catch(""),
});
const gitlabNoteNodeSchema = z.looseObject({
  body: z.string().catch(""),
  system: z.boolean().catch(false),
  createdAt: z.string().catch(""),
  author: gitlabUserNodeSchema.nullish().catch(null),
  position: z
    .looseObject({
      newPath: z.string().nullable().catch(null),
      oldPath: z.string().nullable().catch(null),
      newLine: z.number().int().nullable().catch(null),
      oldLine: z.number().int().nullable().catch(null),
    })
    .nullish()
    .catch(null),
});
const gitlabIssueDetailSchema = gitlabItemNodeSchema.extend({
  notes: connectionOf(gitlabNoteNodeSchema),
});
const gitlabMergeRequestDetailSchema = gitlabItemNodeSchema.extend({
  createdAt: z.string().catch(""),
  sourceBranch: z.string().catch(""),
  targetBranch: z.string().catch(""),
  conflicts: z.boolean().catch(false),
  detailedMergeStatus: z.string().nullable().catch(null),
  reviewers: connectionOf(gitlabUserNodeSchema),
  diffStatsSummary: z
    .looseObject({
      additions: z.number().int().nonnegative().catch(0),
      deletions: z.number().int().nonnegative().catch(0),
      fileCount: z.number().int().nonnegative().catch(0),
    })
    .nullish()
    .catch(null),
  diffStats: z
    .array(
      z.looseObject({
        path: z.string().catch(""),
        additions: z.number().int().nonnegative().catch(0),
        deletions: z.number().int().nonnegative().catch(0),
      }),
    )
    .catch([]),
  headPipeline: z
    .looseObject({
      status: z.string().catch(""),
      path: z.string().catch(""),
    })
    .nullish()
    .catch(null),
  notes: connectionOf(gitlabNoteNodeSchema),
});
const gitlabDiscussionsSchema = connectionOf(
  z.looseObject({
    resolvable: z.boolean().catch(false),
    resolved: z.boolean().catch(false),
    notes: connectionOf(gitlabNoteNodeSchema),
  }),
);
const gitlabDiffsSchema = z
  .looseObject({
    pageInfo: z
      .looseObject({ hasNextPage: z.boolean().catch(false) })
      .catch({ hasNextPage: false }),
    nodes: z
      .array(
        z.looseObject({
          oldPath: z.string().nullable().catch(null),
          newPath: z.string().nullable().catch(null),
          newFile: looseBooleanSchema,
          deletedFile: looseBooleanSchema,
          renamedFile: looseBooleanSchema,
          diff: z.string().catch(""),
        }),
      )
      .catch([]),
  })
  .nullish()
  .catch(null);
const gitlabJobsSchema = connectionOf(
  z.looseObject({
    name: z.string().catch("job"),
    status: z.string().catch(""),
    webPath: z.string().catch(""),
  }),
);
const gitlabApprovalsSchema = z
  .looseObject({
    approvalsRequired: z.number().int().nonnegative().catch(0),
    approvalsLeft: z.number().int().nonnegative().catch(0),
    approvedBy: connectionOf(gitlabUserNodeSchema),
  })
  .catch({ approvalsRequired: 0, approvalsLeft: 0, approvedBy: null });
const gitlabMutationErrorsSchema = z
  .looseObject({ errors: z.array(z.string()).catch([]) })
  .nullish()
  .catch(null);
const graphqlResponseSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z
    .array(z.looseObject({ message: z.string().catch("unknown error") }))
    .optional()
    .catch(undefined),
});

/** A `{ project(fullPath:) { … } }` result; a missing project parses as null. */
function projectResultOf<T extends z.ZodType>(project: T) {
  return z
    .looseObject({ project: project.nullish().catch(null) })
    .catch({ project: null });
}

/** A `project { item: issue|mergeRequest(iid:) { … } }` result. */
function itemResultOf<T extends z.ZodType>(item: T) {
  return projectResultOf(z.looseObject({ item: item.nullish().catch(null) }));
}

const issueDetailResultSchema = itemResultOf(gitlabIssueDetailSchema);
const mergeRequestDetailResultSchema = itemResultOf(
  gitlabMergeRequestDetailSchema,
);
const itemDetailResultSchema = itemResultOf(gitlabItemNodeSchema);
const mergeRequestDiscussionsSchema = z
  .looseObject({ discussions: gitlabDiscussionsSchema })
  .catch({ discussions: null });
const mergeRequestDiffsSchema = z
  .looseObject({ diffs: gitlabDiffsSchema })
  .catch({ diffs: null });
const mergeRequestJobsSchema = z
  .looseObject({
    headPipeline: z
      .looseObject({ jobs: gitlabJobsSchema })
      .nullish()
      .catch(null),
  })
  .catch({ headPipeline: null });
const updatedIssueSchema = z
  .looseObject({
    issue: z
      .looseObject({
        state: z.string().optional().catch(undefined),
        labels: connectionOf(gitlabLabelNodeSchema),
        assignees: connectionOf(gitlabUserNodeSchema),
      })
      .nullish()
      .catch(null),
  })
  .catch({ issue: null });
const createdIssueSchema = z
  .looseObject({
    issue: z
      .looseObject({
        iid: z.coerce.number().int().positive().nullable().catch(null),
        webUrl: z.string().catch(""),
      })
      .nullish()
      .catch(null),
  })
  .catch({ issue: null });

/** The `project.item` object of an itemQuery result, unparsed. */
function itemOf(data: unknown): unknown {
  return z
    .looseObject({
      project: z.looseObject({ item: z.unknown() }).nullish().catch(null),
    })
    .catch({ project: null })
    .parse(data).project?.item;
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

type GitlabUserNode = z.infer<typeof gitlabUserNodeSchema>;
type GitlabItemNode = z.infer<typeof gitlabItemNodeSchema>;
type GitlabNoteNode = z.infer<typeof gitlabNoteNodeSchema>;

interface ProjectInfo {
  /** "host/group/sub/project" */
  project: string;
  host: string;
  path: string;
  /** The BB project whose remote points at it, when there is one. */
  bbProjectId: string | null;
}

interface CachedItem {
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

interface Note {
  author: string;
  body: string;
  createdAt: string;
}

interface ThreadLink {
  kind: "issue" | "mr";
  project: string;
  iid: number;
  threadId: string;
  createdAt: string;
}

/**
 * Runs one GraphQL request through `glab api graphql` on a glab host and
 * resolves to the response's `data`. GraphQL errors reject.
 */
type GitlabGraphql = (
  host: string,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// GraphQL documents. Issue and MergeRequest share these field names, so one
// selection serves both; MergeRequest adds `draft`.
// ---------------------------------------------------------------------------
const ISSUE_FIELDS = `
  iid title state webUrl description updatedAt
  author { username }
  labels { nodes { title } }
  assignees { nodes { username } }`;
const MERGE_REQUEST_FIELDS = `${ISSUE_FIELDS} draft`;
const NOTE_FIELDS = "body system createdAt author { username }";

const SYNC_QUERY = `
  query GitlabSync($path: ID!) {
    project(fullPath: $path) {
      openIssues: issues(state: opened, sort: UPDATED_DESC, first: ${ISSUE_PAGE}) {
        nodes { ${ISSUE_FIELDS} }
      }
      closedIssues: issues(state: closed, sort: UPDATED_DESC, first: ${CLOSED_ISSUE_PAGE}) {
        nodes { ${ISSUE_FIELDS} }
      }
      openMergeRequests: mergeRequests(state: opened, sort: UPDATED_DESC, first: ${MR_PAGE}) {
        nodes { ${MERGE_REQUEST_FIELDS} }
      }
      closedMergeRequests: mergeRequests(state: closed, sort: UPDATED_DESC, first: ${CLOSED_MR_PAGE}) {
        nodes { ${MERGE_REQUEST_FIELDS} }
      }
      mergedMergeRequests: mergeRequests(state: merged, sort: UPDATED_DESC, first: ${CLOSED_MR_PAGE}) {
        nodes { ${MERGE_REQUEST_FIELDS} }
      }
    }
  }`;

const VIEWER_QUERY = "query GitlabViewer { currentUser { username } }";

const MEMBERS_QUERY = `
  query GitlabMembers($path: ID!) {
    project(fullPath: $path) {
      projectMembers(first: 100) { nodes { user { username } } }
    }
  }`;

const LABELS_QUERY = `
  query GitlabLabels($path: ID!, $after: String) {
    project(fullPath: $path) {
      labels(first: 100, after: $after, includeAncestorGroups: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id title }
      }
    }
  }`;

/** One issue or merge request, by iid, with the given selection. */
function itemQuery(kind: "issue" | "mr", selection: string): string {
  const field = kind === "mr" ? "mergeRequest" : "issue";
  return `
    query GitlabItem($path: ID!, $iid: String!) {
      project(fullPath: $path) {
        item: ${field}(iid: $iid) { ${selection} }
      }
    }`;
}

const ISSUE_QUERY = itemQuery("issue", ISSUE_FIELDS);
const MERGE_REQUEST_QUERY = itemQuery("mr", MERGE_REQUEST_FIELDS);

const ISSUE_DETAIL_QUERY = itemQuery(
  "issue",
  `${ISSUE_FIELDS} notes(first: 100) { nodes { ${NOTE_FIELDS} } }`,
);

const MERGE_REQUEST_DETAIL_QUERY = itemQuery(
  "mr",
  `${MERGE_REQUEST_FIELDS}
   createdAt sourceBranch targetBranch conflicts detailedMergeStatus
   reviewers { nodes { username } }
   diffStatsSummary { additions deletions fileCount }
   diffStats { path additions deletions }
   headPipeline { status path }
   notes(first: 100) { nodes { ${NOTE_FIELDS} } }`,
);

/**
 * The parts of a merge request that a given instance or plan may not have
 * (approvals are Premium, `diffs` is recent). Each runs as its own request,
 * so a schema error there degrades one section instead of the whole view.
 */
const MERGE_REQUEST_SECTION_QUERIES = {
  discussions: itemQuery(
    "mr",
    `discussions(first: 100) {
       nodes {
         resolvable resolved
         notes { nodes { ${NOTE_FIELDS} position { newPath oldPath newLine oldLine } } }
       }
     }`,
  ),
  diffs: itemQuery(
    "mr",
    `diffs(first: ${DIFF_PAGE}) {
       pageInfo { hasNextPage }
       nodes { oldPath newPath newFile deletedFile renamedFile diff }
     }`,
  ),
  approvals: itemQuery(
    "mr",
    "approvalsRequired approvalsLeft approvedBy { nodes { username } }",
  ),
  jobs: itemQuery(
    "mr",
    "headPipeline { jobs(first: 100) { nodes { name status webPath } } }",
  ),
} as const;

const UPDATE_ISSUE_MUTATION = `
  mutation GitlabUpdateIssue($input: UpdateIssueInput!) {
    updateIssue(input: $input) {
      errors
      issue { state labels { nodes { title } } }
    }
  }`;

const SET_ASSIGNEES_MUTATION = `
  mutation GitlabSetAssignees($input: IssueSetAssigneesInput!) {
    issueSetAssignees(input: $input) {
      errors
      issue { assignees { nodes { username } } }
    }
  }`;

const CREATE_NOTE_MUTATION = `
  mutation GitlabCreateNote($input: CreateNoteInput!) {
    createNote(input: $input) { errors }
  }`;

const CREATE_ISSUE_MUTATION = `
  mutation GitlabCreateIssue($input: CreateIssueInput!) {
    createIssue(input: $input) {
      errors
      issue { iid webUrl }
    }
  }`;

/**
 * Shell commands an agent runs to read an issue or merge request through
 * GraphQL: the item with its comments, plus the diff for a merge request.
 * Project refs and iids match strict patterns, so they need no escaping.
 */
export function graphqlReadCommands(
  kind: "issue" | "mr",
  project: string,
  iid: number,
): string[] {
  const { host, path } = parseProjectRef(project);
  const command = (selection: string): string => {
    const field = kind === "mr" ? "mergeRequest" : "issue";
    const query =
      "query($path: ID!, $iid: String!) { project(fullPath: $path) { " +
      `${field}(iid: $iid) { ${selection} } } }`;
    return `glab api graphql --hostname ${host} -f path=${path} -f iid=${iid} -f query='${query}'`;
  };
  const comments =
    "notes(first: 100) { nodes { system body createdAt author { username } } }";
  if (kind === "issue") {
    return [command(`title state webUrl description ${comments}`)];
  }
  return [
    command(
      `title state webUrl description sourceBranch targetBranch ${comments}`,
    ),
    command(`diffs(first: ${DIFF_PAGE}) { nodes { oldPath newPath diff } }`),
  ];
}

/** The `data` of a GraphQL response, or an error carrying its messages. */
export function graphqlData(raw: unknown): unknown {
  const parsed = graphqlResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed GitLab GraphQL response");
  const { data, errors } = parsed.data;
  if (errors !== undefined && errors.length > 0) {
    throw new Error(
      `GitLab GraphQL error: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return data ?? null;
}

/**
 * The payload of mutation `field`. GitLab reports refused mutations (bad
 * input, missing permission) in the payload's `errors`, not as GraphQL errors.
 */
export function mutationPayload(data: unknown, field: string): unknown {
  const payload =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)[field]
      : undefined;
  if (payload == null) throw new Error(`GitLab ${field} returned no result`);
  const errors = gitlabMutationErrorsSchema.parse(payload)?.errors ?? [];
  if (errors.length > 0) {
    throw new Error(`GitLab ${field} failed: ${errors.join("; ")}`);
  }
  return payload;
}

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
}

/**
 * One GitLab instance as glab knows it. `host` is the name `glab --hostname`
 * takes and `glab auth status` prints; the rest is that host's glab config,
 * which is where non-default hosting is described:
 *
 * - `subfolder` — GitLab served under a path, https://example.com/gitlab/
 * - `sshHost`   — git over SSH answers on another name than the API
 * - `apiHost`   — the API answers on another name, possibly with a port
 *
 * glab applies all of it; this plugin only has to recognize the remotes those
 * setups produce and map them back to `host`.
 */
export interface GitlabHost {
  host: string;
  subfolder: string;
  sshHost: string | null;
  apiHost: string | null;
}

/**
 * A comparable hostname: lowercased, punycoded, port and brackets removed.
 * Null for anything that cannot be a `--hostname` (an IPv6 literal, which
 * glab rejects outright, or a value the URL parser refuses).
 */
export function normalizeHostname(value: string): string | null {
  const bare = value.trim().replace(/\/+$/, "");
  if (bare.length === 0 || bare.startsWith("[")) return null;
  try {
    const { hostname } = new URL(`https://${bare}`);
    // IDN arrives as punycode here, which is what DNS and glab both want.
    return hostname.startsWith("[") || hostname.length === 0 ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * "host/path" from any git remote URL that belongs to one of the instances
 * glab is authenticated with, else null. Handles https, scp-style
 * `git@host:group/app.git`, and `ssh://git@host:2222/group/app.git`, and
 * resolves the three ways a remote's host can differ from the glab host name:
 * an `ssh_host`, an `api_host` (with or without a port), and a `subfolder`
 * that is part of the URL but not part of the project path.
 */
export function parseGitlabRemote(
  url: string,
  knownHosts: readonly GitlabHost[],
): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const withScheme = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/i,
  );
  const scpStyle = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  const match = withScheme ?? scpStyle;
  if (match === null) return null;
  const remoteHost = normalizeHostname(match[1]);
  if (remoteHost === null) return null;
  const known = knownHosts.find((candidate) =>
    [candidate.host, candidate.sshHost, candidate.apiHost].some(
      (name) => name != null && normalizeHostname(name) === remoteHost,
    ),
  );
  if (known === undefined) return null;
  const remotePath = match[2].replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  // A subfolder is part of the URL but not part of the project path.
  const prefix = known.subfolder.replace(/^\/+|\/+$/g, "");
  const path =
    prefix.length > 0 && remotePath.startsWith(`${prefix}/`)
      ? remotePath.slice(prefix.length + 1)
      : remotePath;
  if (!path.includes("/")) return null;
  const ref = `${normalizeHostname(known.host) ?? known.host}/${path}`;
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

/**
 * A user-written project entry ("HTTPS://Example.COM:8443/gitlab/group/app",
 * "group/app") as a project ref, or null when it cannot be one. Bare paths
 * take `fallbackHost`.
 */
export function normalizeProjectRef(
  entry: string,
  knownHosts: readonly GitlabHost[],
  fallbackHost: string,
): string | null {
  const trimmed = entry.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const asRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const viaKnownHost = parseGitlabRemote(asRemote, knownHosts);
  if (viaKnownHost !== null) return viaKnownHost;
  // An entry for an instance glab does not know yet: keep it addressable, so
  // logging in later starts tracking it instead of silently dropping it.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = withoutScheme.split("/").filter((part) => part.length > 0);
  const [first, ...rest] = segments;
  if (first === undefined) return null;
  const host = normalizeHostname(first);
  const looksHostQualified = host !== null && rest.length >= 2;
  const ref = looksHostQualified
    ? `${host}/${rest.join("/")}`
    : `${normalizeHostname(fallbackHost) ?? ""}/${segments.join("/")}`;
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

/** Splits a project ref into its host and its namespace path. */
export function parseProjectRef(ref: string): { host: string; path: string } {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(`malformed GitLab project ref "${ref}"`);
  }
  return { host: ref.slice(0, separator), path: ref.slice(separator + 1) };
}

export function isProjectRef(value: unknown): value is string {
  return typeof value === "string" && PROJECT_REF_PATTERN.test(value);
}

/**
 * Hosts `glab auth status` reports as logged in (stdout+stderr combined).
 * Whatever name glab prints is the name `--hostname` expects back, so it is
 * only case/IDN-normalized here, never rewritten.
 */
export function parseAuthenticatedHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/Logged in to (\S+) as /);
    if (match === null) continue;
    const host = normalizeHostname(match[1]);
    if (host !== null) hosts.add(host);
  }
  return [...hosts];
}

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

export function validateGitlabCliArgs(argv: string[]): string | null {
  const [sub, arg, ...rest] = argv;
  if (rest.length > 0) return `Unexpected argument "${rest[0]}".`;
  if (sub === undefined) return null;
  if (sub === "help" || sub === "--help") {
    return arg === undefined ? null : `Unexpected argument "${arg}".`;
  }
  if (sub === "projects" || sub === "sync") {
    return arg === undefined
      ? null
      : `Subcommand "${sub}" does not accept arguments.`;
  }
  if ((sub === "issues" || sub === "mrs") && arg !== undefined) {
    return isProjectRef(arg)
      ? null
      : `Invalid project "${arg}"; expected host/group/project.`;
  }
  return null;
}

function usernames(
  connection: { nodes: Array<GitlabUserNode | null> } | null | undefined,
): string[] {
  return nodesOf(connection)
    .map((node) => node.username)
    .filter((name) => name.length > 0);
}

function labelTitles(
  connection: { nodes: Array<{ title: string } | null> } | null | undefined,
): string[] {
  return nodesOf(connection)
    .map((node) => node.title)
    .filter((title) => title.length > 0);
}

/** Human notes of a note list — GitLab's activity feed is in there too. */
function toNotes(notes: readonly GitlabNoteNode[]): Note[] {
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

function run(
  file: string,
  args: string[],
  timeoutMs = 30_000,
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  const child = execFile(
    file,
    args,
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${file} ${args.slice(0, 3).join(" ")} failed: ${
              stderr.trim() || error.message
            }`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    },
  );
  if (stdin !== undefined) child.stdin?.end(stdin);
  return promise;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraProjects: {
      type: "string",
      label: "Extra projects",
      description:
        'Comma-separated "host/group/project" list to track in addition to the ' +
        "projects discovered from BB projects. A bare path uses the default host.",
      default: "",
    },
    defaultHost: {
      type: "string",
      label: "Default GitLab host",
      description:
        "Host used for extra projects written without one, e.g. gitlab.com.",
      default: "gitlab.com",
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where agent threads spawn for GitLab projects that are not attached to a BB project.",
    },
  });

  // ------------------------------------------------------------------
  // glab CLI plumbing. The server process may have a trimmed PATH, so probe
  // common install locations once and remember the winner.
  // ------------------------------------------------------------------
  let glabPath: string | null = null;
  let glabAuthError: string | null = "checking glab…";
  let authenticatedHosts: GitlabHost[] = [];

  async function resolveGlab(): Promise<string> {
    if (glabPath !== null) return glabPath;
    const candidates = [
      "glab",
      "/opt/homebrew/bin/glab",
      "/usr/local/bin/glab",
    ];
    for (const candidate of candidates) {
      try {
        await run(candidate, ["--version"], 5_000);
        glabPath = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw needsConfiguration(`GitLab CLI not found. ${GLAB_HINT}`);
  }

  async function glab(
    args: string[],
    timeoutMs?: number,
    stdin?: string,
  ): Promise<string> {
    const file = await resolveGlab();
    const { stdout } = await run(file, args, timeoutMs, stdin);
    return stdout;
  }

  /**
   * The request body goes to glab as JSON on stdin (`--input -`), so query
   * text and variables reach GitLab exactly as written: no field-type
   * guessing, no placeholder expansion, and no argv length limit.
   */
  const gitlabGraphql: GitlabGraphql = async (host, query, variables = {}) => {
    const stdout = await glab(
      ["api", "graphql", "--hostname", host, "--method", "POST", "--input", "-"],
      30_000,
      JSON.stringify({ query, variables }),
    );
    return graphqlData(JSON.parse(stdout) as unknown);
  };

  /**
   * How this instance is reached, straight from its glab config. Unset keys
   * print nothing, and an unreadable key degrades to "not configured" rather
   * than failing the whole auth check.
   */
  async function readHostConfig(host: string): Promise<GitlabHost> {
    const read = async (key: string): Promise<string> => {
      try {
        return (await glab(["config", "get", key, "--host", host], 10_000)).trim();
      } catch {
        return "";
      }
    };
    const [subfolder, sshHost, apiHost] = await Promise.all([
      read("subfolder"),
      read("ssh_host"),
      read("api_host"),
    ]);
    return {
      host,
      subfolder,
      sshHost: sshHost.length > 0 ? sshHost : null,
      apiHost: apiHost.length > 0 ? apiHost : null,
    };
  }

  async function checkAuth(): Promise<void> {
    const file = await resolveGlab();
    // `glab auth status` writes its report to stderr and exits non-zero when
    // any configured host fails, so read the text rather than the exit code.
    const { promise, resolve } = Promise.withResolvers<string>();
    execFile(
      file,
      ["auth", "status"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
    const hosts = parseAuthenticatedHosts(await promise);
    if (hosts.length === 0) {
      glabAuthError = `GitLab CLI is not authenticated with any host. ${GLAB_HINT}`;
      throw needsConfiguration(glabAuthError);
    }
    authenticatedHosts = await Promise.all(hosts.map(readHostConfig));
    glabAuthError = null;
  }

  // ------------------------------------------------------------------
  // Project discovery: BB project git remotes → host/path. The remote comes
  // from BB's own project record, so a checkout living on an enrolled remote
  // host resolves exactly like a local one.
  // ------------------------------------------------------------------
  let projectCache: { projects: ProjectInfo[]; fetchedAt: number } | null = null;

  async function discoverProjects(force = false): Promise<ProjectInfo[]> {
    if (
      !force &&
      projectCache !== null &&
      Date.now() - projectCache.fetchedAt < 60_000
    ) {
      return projectCache.projects;
    }
    const byRef = new Map<string, ProjectInfo>();
    const addRef = (ref: string, bbProjectId: string | null): void => {
      if (byRef.has(ref)) return;
      const { host, path } = parseProjectRef(ref);
      byRef.set(ref, { project: ref, host, path, bbProjectId });
    };
    try {
      for (const bbProject of await bb.sdk.projects.list()) {
        if (bbProject.gitRemoteUrl === null) continue;
        const ref = parseGitlabRemote(bbProject.gitRemoteUrl, authenticatedHosts);
        if (ref !== null) {
          addRef(ref, bbProject.id);
          continue;
        }
        // Not one of glab's hosts. Say so once per sync: on a self-managed
        // instance the fix is `glab auth login --hostname <host>`, and silence
        // here reads as the plugin ignoring the project.
        const remoteHost = bbProject.gitRemoteUrl.match(
          /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)/i,
        );
        if (remoteHost !== null) {
          bb.log.debug(
            `project ${bbProject.id} remote host ${remoteHost[1]} is not an authenticated glab host`,
          );
        }
      }
    } catch (error) {
      bb.log.warn(
        `project discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const { extraProjects, defaultHost } = await settings.get();
    for (const raw of extraProjects.split(/[\s,]+/)) {
      if (raw.trim().length === 0) continue;
      const ref = normalizeProjectRef(raw, authenticatedHosts, defaultHost);
      if (ref !== null) addRef(ref, null);
      else bb.log.warn(`ignoring malformed extraProjects entry "${raw}"`);
    }
    const projects = [...byRef.values()];
    projectCache = { projects, fetchedAt: Date.now() };
    return projects;
  }

  // ------------------------------------------------------------------
  // SQLite cache of open issues + merge requests across tracked projects.
  // ------------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
       project TEXT NOT NULL,
       iid INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       draft INTEGER NOT NULL DEFAULT 0,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       assignees TEXT NOT NULL DEFAULT '[]',
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project, kind, iid)
     )`,
  ]);

  const cachedStringArraySchema = z.array(z.string()).catch([]);

  function rowToItem(row: Record<string, unknown>): CachedItem {
    return {
      project: String(row.project),
      iid: Number(row.iid),
      kind: row.kind === "mr" ? "mr" : "issue",
      title: String(row.title),
      state: String(row.state),
      draft: Number(row.draft) === 1,
      author: String(row.author),
      // Written by this plugin, but a corrupt row must not fail the list.
      labels: cachedStringArraySchema.parse(JSON.parse(String(row.labels))),
      assignees: cachedStringArraySchema.parse(
        JSON.parse(String(row.assignees)),
      ),
      url: String(row.url),
      body: String(row.body),
      updatedAt: String(row.updated_at),
    };
  }

  function listCachedItems(options: {
    kind?: "issue" | "mr";
    project?: string;
    query?: string;
    /** "open" → opened only; "closed" → everything else (closed, merged). */
    state?: "open" | "closed";
  }): CachedItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.project !== undefined) {
      clauses.push("project = ?");
      params.push(options.project);
    }
    if (options.state === "open") {
      clauses.push("state = 'opened'");
    } else if (options.state === "closed") {
      clauses.push("state != 'opened'");
    }
    const query = options.query?.trim() ?? "";
    if (query.length > 0) {
      clauses.push(
        "(title LIKE ? OR CAST(iid AS TEXT) LIKE ? OR project LIKE ?)",
      );
      const like = `%${query.replace(/^[#!]/, "")}%`;
      params.push(like, like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }

  function getCachedItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): CachedItem | null {
    const row = db
      .prepare("SELECT * FROM items WHERE project = ? AND kind = ? AND iid = ?")
      .get(project, kind, iid) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToItem(row);
  }

  function replaceProjectRows(project: string, items: CachedItem[]): void {
    const insert = db.prepare(
      `INSERT INTO items (project, iid, kind, title, state, draft, author, labels, assignees, url, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE project = ?").run(project);
      for (const item of items) {
        insert.run(
          item.project,
          item.iid,
          item.kind,
          item.title,
          item.state,
          item.draft ? 1 : 0,
          item.author,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          item.url,
          item.body,
          item.updatedAt,
        );
      }
    })();
  }

  /** Patch a cached row in place after a mutation so the UI updates without
      waiting for the next full sync. */
  function patchCachedItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    patch: { state?: string; assignees?: string[]; labels?: string[] },
  ): void {
    if (patch.state !== undefined) {
      db.prepare(
        "UPDATE items SET state = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(patch.state, project, kind, iid);
    }
    if (patch.assignees !== undefined) {
      db.prepare(
        "UPDATE items SET assignees = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.assignees), project, kind, iid);
    }
    if (patch.labels !== undefined) {
      db.prepare(
        "UPDATE items SET labels = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.labels), project, kind, iid);
    }
    bb.realtime.publish("data-changed", {});
  }

  async function syncAll(
    force = false,
  ): Promise<{ projects: number; items: number }> {
    await checkAuth();
    const projects = await discoverProjects(force);
    // Cheap change detection so idle syncs don't wake every panel.
    const fingerprint = db.prepare(
      "SELECT project, kind, iid, state, updated_at FROM items ORDER BY project, kind, iid",
    );
    const before = JSON.stringify(fingerprint.all());
    // A project that stopped being tracked — removed from extraProjects, or
    // gone from GitLab — must not keep serving rows to lists and mentions.
    const tracked = projects.map((entry) => entry.project);
    if (tracked.length === 0) {
      db.prepare("DELETE FROM items").run();
    } else {
      db.prepare(
        `DELETE FROM items WHERE project NOT IN (${tracked.map(() => "?").join(",")})`,
      ).run(...tracked);
    }
    let total = 0;
    for (const { project } of projects) {
      try {
        const items = await fetchProjectItems(gitlabGraphql, project);
        replaceProjectRows(project, items);
        total += items.length;
      } catch (error) {
        bb.log.warn(
          `sync failed for ${project}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await bb.storage.kv.set("sync-cursor", {
      lastSyncedAt: new Date().toISOString(),
      projects: projects.length,
      items: total,
    });
    if (before !== JSON.stringify(fingerprint.all())) {
      bb.realtime.publish("data-changed", { items: total });
    }
    bb.log.info(`synced ${total} item(s) across ${projects.length} project(s)`);
    return { projects: projects.length, items: total };
  }

  // Initial sync + 5-minute refresh loop. NeedsConfigurationError from a
  // missing/unauthenticated glab flips the plugin to needs-configuration
  // instead of crash-looping. The abort check after each sync is load-bearing:
  // an abort that lands mid-sync would otherwise register its listener on an
  // already-aborted signal, which never fires, and the reload would wait out
  // the full interval and report the plugin degraded.
  bb.background.service("sync", {
    async start(signal) {
      while (!signal.aborted) {
        await syncAll();
        if (signal.aborted) break;
        const sleep = Promise.withResolvers<void>();
        const timer = setTimeout(sleep.resolve, SYNC_INTERVAL_MS);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            sleep.resolve();
          },
          { once: true },
        );
        await sleep.promise;
      }
    },
  });

  // Surface an unconfigured glab immediately instead of waiting for the
  // service's first crash.
  try {
    await checkAuth();
  } catch (error) {
    bb.status.needsConfiguration(
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------------
  // Issue/MR ↔ thread links (the pills in the UI).
  // kv: "link:<kind>:<project>!<iid>" → ThreadLink[]
  // ------------------------------------------------------------------
  async function addLink(link: ThreadLink): Promise<void> {
    const key = `link:${link.kind}:${link.project}!${link.iid}`;
    const existing = (await bb.storage.kv.get<ThreadLink[]>(key)) ?? [];
    await bb.storage.kv.set(key, [...existing, link]);
    bb.realtime.publish("links-changed", { key });
  }

  async function listAllLinks(): Promise<Record<string, ThreadLink[]>> {
    const keys = await bb.storage.kv.list("link:");
    const result: Record<string, ThreadLink[]> = {};
    for (const key of keys) {
      const links = await bb.storage.kv.get<ThreadLink[]>(key);
      if (links !== undefined && links.length > 0) {
        result[key.slice("link:".length)] = links;
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Spawning agent threads on issues / MR reviews.
  // ------------------------------------------------------------------
  async function resolveBbProjectId(project: string): Promise<string> {
    const projects = await discoverProjects();
    const info = projects.find((entry) => entry.project === project);
    if (info?.bbProjectId != null) return info.bbProjectId;
    const { defaultProject } = await settings.get();
    if (defaultProject) return defaultProject;
    throw new Error(
      `No BB project is attached to ${project}. Create a project whose checkout has ` +
        "that origin remote, or set the defaultProject plugin setting.",
    );
  }

  async function spawnOnItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): Promise<{ threadId: string }> {
    const item = getCachedItem(kind, project, iid);
    const noun = kind === "mr" ? "merge request" : "issue";
    const marker = kind === "mr" ? "!" : "#";
    const title = item?.title ?? `${noun} ${marker}${iid}`;
    const bbProjectId = await resolveBbProjectId(project);
    const ref = `${project}${marker}${iid}`;
    const prompt =
      kind === "issue"
        ? [
            `Work on GitLab issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            ...graphqlReadCommands("issue", project, iid).map(
              (command) => `  ${command}`,
            ),
            "",
            item !== null && item.body.length > 0
              ? `Issue description:\n\n${item.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a merge request, include "Closes #${iid}" in its description.`,
          ].join("\n")
        : [
            `Review GitLab merge request ${ref}: ${title}`,
            "",
            "Read the merge request and its diff:",
            ...graphqlReadCommands("mr", project, iid).map(
              (command) => `  ${command}`,
            ),
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitLab unless asked.",
          ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: bbProjectId,
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      prompt,
    });
    await addLink({
      kind,
      project,
      iid,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    bb.log.info(`spawned thread ${thread.id} for ${noun} ${ref}`);
    return { threadId: thread.id };
  }

  // ------------------------------------------------------------------
  // Viewer identity + per-project members and labels, cached in memory so the
  // filter chips and pickers don't hit the network on every render.
  // ------------------------------------------------------------------
  const viewerCache = new Map<string, { username: string; fetchedAt: number }>();
  const membersCache = new Map<
    string,
    { members: string[]; fetchedAt: number }
  >();
  const labelsCache = new Map<
    string,
    { labels: Array<{ id: string; title: string }>; fetchedAt: number }
  >();

  const viewerResultSchema = z
    .looseObject({ currentUser: gitlabUserNodeSchema.nullish().catch(null) })
    .catch({ currentUser: null });
  const membersResultSchema = projectResultOf(
    z.looseObject({
      projectMembers: connectionOf(
        z.looseObject({ user: gitlabUserNodeSchema.nullish().catch(null) }),
      ),
    }),
  );
  const labelsResultSchema = projectResultOf(
    z.looseObject({
      labels: z
        .looseObject({
          pageInfo: z
            .looseObject({
              hasNextPage: z.boolean().catch(false),
              endCursor: z.string().nullable().catch(null),
            })
            .catch({ hasNextPage: false, endCursor: null }),
          nodes: z.array(gitlabLabelNodeSchema.nullable().catch(null)).catch([]),
        })
        .nullish()
        .catch(null),
    }),
  );
  type LabelsConnection = NonNullable<
    z.infer<typeof labelsResultSchema>["project"]
  >["labels"];
  /** Label pages to walk before giving up on a project's label list. */
  const MAX_LABEL_PAGES = 10;

  async function getViewer(host?: string): Promise<string> {
    const resolvedHost = host ?? authenticatedHosts[0]?.host;
    if (resolvedHost === undefined) {
      throw needsConfiguration(`No authenticated GitLab host. ${GLAB_HINT}`);
    }
    const cached = viewerCache.get(resolvedHost);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 60 * 60_000) {
      return cached.username;
    }
    const { currentUser } = viewerResultSchema.parse(
      await gitlabGraphql(resolvedHost, VIEWER_QUERY),
    );
    const username = currentUser?.username ?? "";
    if (username.length === 0) {
      throw new Error(`could not resolve the glab user on ${resolvedHost}`);
    }
    viewerCache.set(resolvedHost, { username, fetchedAt: Date.now() });
    return username;
  }

  /** Usernames of the project's direct and inherited members. */
  async function getMembers(project: string): Promise<string[]> {
    const cached = membersCache.get(project);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.members;
    }
    const { host, path } = parseProjectRef(project);
    const result = membersResultSchema.parse(
      await gitlabGraphql(host, MEMBERS_QUERY, { path }),
    ).project;
    const members = nodesOf(result?.projectMembers)
      .map((member) => member.user?.username ?? "")
      .filter((name) => name.length > 0);
    membersCache.set(project, { members, fetchedAt: Date.now() });
    return members;
  }

  /**
   * Project and ancestor-group labels with their global ids, which is what
   * GraphQL mutations take. Group labels can repeat a project label's title;
   * the first one GitLab returns wins.
   */
  async function getProjectLabels(
    project: string,
    force = false,
  ): Promise<Array<{ id: string; title: string }>> {
    const cached = labelsCache.get(project);
    if (
      !force &&
      cached !== undefined &&
      Date.now() - cached.fetchedAt < 10 * 60_000
    ) {
      return cached.labels;
    }
    const { host, path } = parseProjectRef(project);
    const byTitle = new Map<string, { id: string; title: string }>();
    let after: string | null = null;
    for (let page = 0; page < MAX_LABEL_PAGES; page += 1) {
      const connection: LabelsConnection = labelsResultSchema.parse(
        await gitlabGraphql(host, LABELS_QUERY, { path, after }),
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
    let labels = await getProjectLabels(project);
    if (titles.some((title) => !labels.some((label) => label.title === title))) {
      labels = await getProjectLabels(project, true);
    }
    return titles.map((title) => {
      const found = labels.find((label) => label.title === title);
      if (found === undefined) throw new Error(`unknown GitLab label "${title}"`);
      return found.id;
    });
  }

  const itemIdResultSchema = projectResultOf(
    z.looseObject({
      item: z.looseObject({ id: z.string().min(1) }).nullish().catch(null),
    }),
  );

  /** The global id of an issue or merge request, which createNote takes. */
  async function getNoteableId(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): Promise<string> {
    const { host, path } = parseProjectRef(project);
    const item = itemIdResultSchema.parse(
      await gitlabGraphql(host, itemQuery(kind, "id"), {
        path,
        iid: String(iid),
      }),
    ).project?.item;
    if (item == null) {
      const marker = kind === "mr" ? "!" : "#";
      throw new Error(`GitLab ${project}${marker}${iid} not found`);
    }
    return item.id;
  }

  async function addNote(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    body: string,
  ): Promise<void> {
    const noteableId = await getNoteableId(kind, project, iid);
    const { host } = parseProjectRef(project);
    mutationPayload(
      await gitlabGraphql(host, CREATE_NOTE_MUTATION, {
        input: { noteableId, body },
      }),
      "createNote",
    );
  }

  // ------------------------------------------------------------------
  // rpc — the frontend data plane.
  // ------------------------------------------------------------------
  bb.rpc.register(gitlabRpcContract, {
    /** () → auth/sync status for the panel banner. */
    async status() {
      const cursor = await bb.storage.kv.get<{
        lastSyncedAt: string;
        projects: number;
        items: number;
      }>("sync-cursor");
      return {
        glabOk: glabAuthError === null,
        glabError: glabAuthError,
        hosts: authenticatedHosts.map((entry) => entry.host),
        projects: await discoverProjects(),
        lastSyncedAt: cursor?.lastSyncedAt ?? null,
      };
    },

    /** () → force a full sync now. */
    async refresh() {
      return await syncAll(true);
    },

    /** { kind?, project?, state? } → cached items, newest first. */
    async listItems(input) {
      return {
        items: listCachedItems({
          kind: input.kind,
          project: input.project,
          state: input.state,
        }),
      };
    },

    /** () → the authenticated glab username, for "assign to me" affordances. */
    async viewer() {
      return { username: await getViewer() };
    },

    /** { project } → usernames that can be assigned in that project. */
    async assignableUsers(input) {
      const members = await getMembers(input.project);
      return {
        users: [...new Set(members)].sort((a, b) => a.localeCompare(b)),
      };
    },

    /** { project } → labels available in that project. */
    async projectLabels(input) {
      const labels = await getProjectLabels(input.project);
      return { labels: labels.map((label) => label.title) };
    },

    /** { project, iid, state } → close or reopen an issue. */
    async setIssueState({ project, iid, state }): Promise<{ ok: true }> {
      const { host, path } = parseProjectRef(project);
      const payload = updatedIssueSchema.parse(
        mutationPayload(
          await gitlabGraphql(host, UPDATE_ISSUE_MUTATION, {
            input: {
              projectPath: path,
              iid: String(iid),
              stateEvent: state === "closed" ? "CLOSE" : "REOPEN",
            },
          }),
          "updateIssue",
        ),
      );
      patchCachedItem("issue", project, iid, {
        state:
          payload.issue?.state ?? (state === "closed" ? "closed" : "opened"),
      });
      return { ok: true };
    },

    /** { project, iid, assignees } → set the exact assignee list. */
    async setAssignees({
      project,
      iid,
      assignees,
    }): Promise<{ ok: true; assignees: string[] }> {
      const { host, path } = parseProjectRef(project);
      const payload = updatedIssueSchema.parse(
        mutationPayload(
          await gitlabGraphql(host, SET_ASSIGNEES_MUTATION, {
            input: {
              projectPath: path,
              iid: String(iid),
              // REPLACE with an empty list clears the assignees.
              assigneeUsernames: [...new Set(assignees)],
              operationMode: "REPLACE",
            },
          }),
          "issueSetAssignees",
        ),
      );
      const applied = usernames(payload.issue?.assignees);
      patchCachedItem("issue", project, iid, { assignees: applied });
      return { ok: true, assignees: applied };
    },

    /** { project, iid, labels } → set the exact issue label list. */
    async setLabels({
      project,
      iid,
      labels,
    }): Promise<{ ok: true; labels: string[] }> {
      const next = [
        ...new Set<string>(labels.map((label) => label.trim()).filter(Boolean)),
      ];
      const { host, path } = parseProjectRef(project);
      const labelIds = await resolveLabelIds(project, next);
      const payload = updatedIssueSchema.parse(
        mutationPayload(
          await gitlabGraphql(host, UPDATE_ISSUE_MUTATION, {
            input: { projectPath: path, iid: String(iid), labelIds },
          }),
          "updateIssue",
        ),
      );
      const applied = labelTitles(payload.issue?.labels);
      patchCachedItem("issue", project, iid, { labels: applied });
      return { ok: true, labels: applied };
    },

    /** { project, iid } → live issue detail incl. comments. */
    async getIssue({ project, iid }) {
      const { host, path } = parseProjectRef(project);
      const detail = issueDetailResultSchema.parse(
        await gitlabGraphql(host, ISSUE_DETAIL_QUERY, {
          path,
          iid: String(iid),
        }),
      ).project?.item;
      if (detail == null) throw new Error(`GitLab ${project}#${iid} not found`);
      return {
        issue: {
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
        },
      };
    },

    /**
     * { project, iid } → full merge-request detail: overview, pipeline jobs
     * (GitLab's answer to checks), approvals, conversation notes, inline
     * discussion threads, and per-file diffs. Approvals, discussions, diffs,
     * and jobs are optional on any given instance or plan, so a failure there
     * degrades that section instead of the whole view.
     */
    async getMergeRequest({ project, iid }) {
      const { host, path } = parseProjectRef(project);
      const variables = { path, iid: String(iid) };
      const optional = async (
        section: keyof typeof MERGE_REQUEST_SECTION_QUERIES,
      ): Promise<unknown> => {
        try {
          return itemOf(
            await gitlabGraphql(
              host,
              MERGE_REQUEST_SECTION_QUERIES[section],
              variables,
            ),
          );
        } catch (error) {
          bb.log.warn(
            `optional merge request ${section} for ${project}!${iid} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      };
      const [detailRaw, discussionsRaw, diffsRaw, approvalsRaw, jobsRaw] =
        await Promise.all([
          gitlabGraphql(host, MERGE_REQUEST_DETAIL_QUERY, variables),
          optional("discussions"),
          optional("diffs"),
          optional("approvals"),
          optional("jobs"),
        ]);
      const detail = mergeRequestDetailResultSchema.parse(detailRaw).project
        ?.item;
      if (detail == null) throw new Error(`GitLab ${project}!${iid} not found`);

      const jobs = nodesOf(
        mergeRequestJobsSchema.parse(jobsRaw).headPipeline?.jobs,
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
        mergeRequestDiscussionsSchema.parse(discussionsRaw).discussions,
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

      // Per-file counts come from diffStats; the diff text, when this
      // instance serves it, from diffs. Without diffs the file list still
      // shows, with every patch left on GitLab.
      const statsByPath = new Map(
        detail.diffStats.map((stat) => [stat.path, stat]),
      );
      const diffs = mergeRequestDiffsSchema.parse(diffsRaw).diffs;
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
      const approvals = gitlabApprovalsSchema.parse(approvalsRaw);

      return {
        mergeRequest: {
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
        },
      };
    },

    /** { project, iid, body } → add an issue comment. */
    async commentIssue({ project, iid, body }): Promise<{ ok: true }> {
      await addNote("issue", project, iid, body);
      return { ok: true };
    },

    /** { project, iid, body } → add a merge-request comment. */
    async commentMergeRequest({ project, iid, body }): Promise<{ ok: true }> {
      await addNote("mr", project, iid, body);
      return { ok: true };
    },

    /** { project, title, body? } → create an issue, refresh, return iid+url. */
    async createIssue(input) {
      const { host, path } = parseProjectRef(input.project);
      const { issue } = createdIssueSchema.parse(
        mutationPayload(
          await gitlabGraphql(host, CREATE_ISSUE_MUTATION, {
            input: {
              projectPath: path,
              title: input.title,
              description: input.body ?? "",
            },
          }),
          "createIssue",
        ),
      );
      try {
        replaceProjectRows(
          input.project,
          await fetchProjectItems(gitlabGraphql, input.project),
        );
        bb.realtime.publish("data-changed", {});
      } catch {
        // creation succeeded; the next scheduled sync will pick it up
      }
      return { iid: issue?.iid ?? null, url: issue?.webUrl ?? "" };
    },

    /** { project, iid } → spawn a worker thread on an issue. */
    async startWork({ project, iid }) {
      return await spawnOnItem("issue", project, iid);
    },

    /** { project, iid } → spawn a review thread on a merge request. */
    async startReview({ project, iid }) {
      return await spawnOnItem("mr", project, iid);
    },

    /**
     * { threadId } → the merge request most relevant to a BB thread: the
     * thread's own environment MR (the branch the agent pushed) first, else an
     * MR this thread was spawned to review. Null when neither exists.
     */
    async mergeRequestForThread({ threadId }) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) {
          const result = await bb.sdk.environments.pullRequest({
            environmentId: thread.environmentId,
          });
          const match =
            result.outcome === "available"
              ? result.pullRequest.url.match(
                  /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/,
                )
              : null;
          if (match !== null) {
            const ref = `${match[1].toLowerCase()}/${match[2]}`;
            if (isProjectRef(ref)) {
              return { mergeRequest: { project: ref, iid: Number(match[3]) } };
            }
          }
        }
      } catch {
        // no environment / MR lookup failed — fall through to spawn links
      }
      const links = await listAllLinks();
      for (const [key, threadLinks] of Object.entries(links)) {
        if (!key.startsWith("mr:")) continue;
        const separator = key.lastIndexOf("!");
        if (separator < 0) continue;
        const project = key.slice("mr:".length, separator);
        const iid = Number(key.slice(separator + 1));
        if (!isProjectRef(project) || !Number.isInteger(iid)) continue;
        if (threadLinks.some((link) => link.threadId === threadId)) {
          return { mergeRequest: { project, iid } };
        }
      }
      return { mergeRequest: null };
    },

    /** () → every issue/MR → thread link, keyed "<kind>:<project>!<iid>". */
    async listLinks() {
      return { links: await listAllLinks() };
    },
  });

  // ------------------------------------------------------------------
  // Mentions: issues (# as on GitLab) and merge requests (! as on GitLab)
  // attach their details as agent context. Search reads the cache (2s time
  // box); resolve prefers a live call and falls back to the cache so a
  // network blip doesn't block the send.
  // ------------------------------------------------------------------
  function mentionItems(kind: "issue" | "mr", query: string) {
    const marker = kind === "mr" ? "!" : "#";
    return listCachedItems({ kind, query, state: "open" })
      .slice(0, 8)
      .map((item) => ({
        id: `${item.project}${marker}${item.iid}`,
        title: `${marker}${item.iid} ${item.title}`,
        subtitle: item.project,
      }));
  }

  async function mentionContext(
    kind: "issue" | "mr",
    itemId: string,
  ): Promise<{ context: string }> {
    const marker = kind === "mr" ? "!" : "#";
    const separator = itemId.lastIndexOf(marker);
    const project = separator < 0 ? "" : itemId.slice(0, separator);
    const iid = Number(itemId.slice(separator + 1));
    if (!isProjectRef(project) || !Number.isInteger(iid) || iid <= 0) {
      throw new Error(`malformed mention id "${itemId}"`);
    }
    const { host, path } = parseProjectRef(project);
    const noun = kind === "mr" ? "merge request" : "issue";
    try {
      const detail = itemDetailResultSchema.parse(
        await gitlabGraphql(
          host,
          kind === "mr" ? MERGE_REQUEST_QUERY : ISSUE_QUERY,
          { path, iid: String(iid) },
        ),
      ).project?.item;
      if (detail == null) {
        throw new Error(`GitLab ${project}${marker}${iid} not found`);
      }
      return {
        context: [
          `# GitLab ${noun} ${project}${marker}${iid}: ${detail.title}`,
          "",
          `State: ${detail.state} · Author: ${detail.author?.username ?? ""}`,
          `URL: ${detail.webUrl}`,
          "",
          detail.description.length > 0 ? detail.description : "(no description)",
          "",
          "For full comments/diff run:",
          ...graphqlReadCommands(kind, project, iid),
        ].join("\n"),
      };
    } catch (error) {
      const cached = getCachedItem(kind, project, iid);
      if (cached === null) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return {
        context: [
          `# GitLab ${noun} ${project}${marker}${iid}: ${cached.title}`,
          "",
          `State: ${cached.state} · Author: ${cached.author}`,
          `URL: ${cached.url}`,
          "",
          cached.body.length > 0 ? cached.body : "(no description)",
        ].join("\n"),
      };
    }
  }

  bb.ui.registerMentionProvider({
    id: "issue",
    label: "GitLab issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });

  bb.ui.registerMentionProvider({
    id: "mr",
    label: "GitLab merge requests",
    triggers: ["@", "!"],
    search({ query }) {
      return mentionItems("mr", query);
    },
    resolve(itemId) {
      return mentionContext("mr", itemId);
    },
  });

  // ------------------------------------------------------------------
  // CLI: `bb gitlab …` for agents and terminals.
  // ------------------------------------------------------------------
  const USAGE = [
    "Usage:",
    "  bb gitlab projects           List tracked GitLab projects",
    "  bb gitlab issues [project]   List cached open issues",
    "  bb gitlab mrs [project]      List cached open merge requests",
    "  bb gitlab sync               Refresh the cache from GitLab now",
    "",
    "A project is written host-qualified: gitlab.com/group/subgroup/app",
  ].join("\n");

  bb.cli.register({
    name: "gitlab",
    summary: "Browse tracked GitLab projects, issues, and merge requests",
    commands: [
      {
        name: "projects",
        summary: "List tracked GitLab projects",
        usage: "bb gitlab projects",
      },
      {
        name: "issues",
        summary: "List cached open issues",
        usage: "bb gitlab issues [host/group/project]",
      },
      {
        name: "mrs",
        summary: "List cached open merge requests",
        usage: "bb gitlab mrs [host/group/project]",
      },
      {
        name: "sync",
        summary: "Refresh the cache from GitLab now",
        usage: "bb gitlab sync",
      },
    ],
    async run(argv) {
      const [sub, arg] = argv;
      try {
        const validationError = validateGitlabCliArgs(argv);
        if (validationError !== null) {
          return { exitCode: 1, stderr: `${validationError}\n${USAGE}` };
        }
        if (sub === undefined || sub === "help" || sub === "--help") {
          return { exitCode: 0, stdout: USAGE };
        }
        if (sub === "projects") {
          const projects = await discoverProjects(true);
          if (projects.length === 0) {
            return {
              exitCode: 0,
              stdout:
                "No tracked projects. Attach a BB project whose checkout has a GitLab " +
                "origin remote, or set extraProjects.",
            };
          }
          return {
            exitCode: 0,
            stdout: projects
              .map(
                (entry) =>
                  `${entry.project}${
                    entry.bbProjectId !== null ? `\t(${entry.bbProjectId})` : ""
                  }`,
              )
              .join("\n"),
          };
        }
        if (sub === "issues" || sub === "mrs") {
          const kind = sub === "mrs" ? "mr" : "issue";
          const marker = kind === "mr" ? "!" : "#";
          const items = listCachedItems({
            kind,
            project: isProjectRef(arg) ? arg : undefined,
            state: "open",
          });
          if (items.length === 0) {
            return {
              exitCode: 0,
              stdout: "Nothing cached. Run `bb gitlab sync` first.",
            };
          }
          return {
            exitCode: 0,
            stdout: items
              .map(
                (item) =>
                  `${item.project}${marker}${item.iid}\t[${
                    item.draft ? "draft" : item.state
                  }]\t${item.title}`,
              )
              .join("\n"),
          };
        }
        if (sub === "sync") {
          const { projects, items } = await syncAll(true);
          return {
            exitCode: 0,
            stdout: `Synced ${items} item(s) across ${projects} project(s).`,
          };
        }
        return {
          exitCode: 1,
          stderr: `Unknown subcommand "${sub}".\n${USAGE}`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
