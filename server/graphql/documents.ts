// GraphQL documents. Issue and MergeRequest share these field names, so one
// selection serves both; MergeRequest adds `draft`.

const ISSUE_PAGE = 100;
const CLOSED_ISSUE_PAGE = 50;
const MR_PAGE = 50;
const CLOSED_MR_PAGE = 30;
/** One page of per-file diffs; a bigger merge request reports truncation. */
export const DIFF_PAGE = 100;

const ISSUE_FIELDS = `
  iid title state webUrl description updatedAt
  author { username }
  labels { nodes { title } }
  assignees { nodes { username } }`;
const MERGE_REQUEST_FIELDS = `${ISSUE_FIELDS} draft`;
const NOTE_FIELDS = "body system createdAt author { username }";

export const SYNC_QUERY = `
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

export const VIEWER_QUERY = "query GitlabViewer { currentUser { username } }";

export const MEMBERS_QUERY = `
  query GitlabMembers($path: ID!) {
    project(fullPath: $path) {
      projectMembers(first: 100) { nodes { user { username } } }
    }
  }`;

export const LABELS_QUERY = `
  query GitlabLabels($path: ID!, $after: String) {
    project(fullPath: $path) {
      labels(first: 100, after: $after, includeAncestorGroups: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id title }
      }
    }
  }`;

/** One issue or merge request, by iid, with the given selection. */
export function itemQuery(kind: "issue" | "mr", selection: string): string {
  const field = kind === "mr" ? "mergeRequest" : "issue";
  return `
    query GitlabItem($path: ID!, $iid: String!) {
      project(fullPath: $path) {
        item: ${field}(iid: $iid) { ${selection} }
      }
    }`;
}

export const ISSUE_QUERY = itemQuery("issue", ISSUE_FIELDS);
export const MERGE_REQUEST_QUERY = itemQuery("mr", MERGE_REQUEST_FIELDS);

export const ISSUE_DETAIL_QUERY = itemQuery(
  "issue",
  `${ISSUE_FIELDS} notes(first: 100) { nodes { ${NOTE_FIELDS} } }`,
);

export const MERGE_REQUEST_DETAIL_QUERY = itemQuery(
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
export const MERGE_REQUEST_SECTION_QUERIES = {
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

export const UPDATE_ISSUE_MUTATION = `
  mutation GitlabUpdateIssue($input: UpdateIssueInput!) {
    updateIssue(input: $input) {
      errors
      issue { state labels { nodes { title } } }
    }
  }`;

export const SET_ASSIGNEES_MUTATION = `
  mutation GitlabSetAssignees($input: IssueSetAssigneesInput!) {
    issueSetAssignees(input: $input) {
      errors
      issue { assignees { nodes { username } } }
    }
  }`;

export const CREATE_NOTE_MUTATION = `
  mutation GitlabCreateNote($input: CreateNoteInput!) {
    createNote(input: $input) { errors }
  }`;

export const CREATE_ISSUE_MUTATION = `
  mutation GitlabCreateIssue($input: CreateIssueInput!) {
    createIssue(input: $input) {
      errors
      issue { iid webUrl }
    }
  }`;
