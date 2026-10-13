// What agents read: the prompt of a thread spawned on an issue or merge
// request, the context a mention attaches, and the GraphQL commands both
// hand out for reading the full item.
import { DIFF_PAGE } from "./graphql/documents";
import { parseProjectRef } from "./project-ref";

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

const MARKERS = { issue: "#", mr: "!" } as const;
const NOUNS = { issue: "issue", mr: "merge request" } as const;

/** The opening prompt of a thread spawned to work on an issue or review an MR. */
export function spawnPrompt(
  kind: "issue" | "mr",
  project: string,
  iid: number,
  title: string,
  /** The cached description, when there is one. */
  body: string | null,
): string {
  const ref = `${project}${MARKERS[kind]}${iid}`;
  const commands = graphqlReadCommands(kind, project, iid).map(
    (command) => `  ${command}`,
  );
  if (kind === "issue") {
    return [
      `Work on GitLab issue ${ref}: ${title}`,
      "",
      "Read the full issue and its comments first:",
      ...commands,
      "",
      body !== null && body.length > 0
        ? `Issue description:\n\n${body}`
        : "(no cached description — read it with the command above)",
      "",
      "Implement a fix or the requested change in this checkout. " +
        `If you open a merge request, include "Closes #${iid}" in its description.`,
    ].join("\n");
  }
  return [
    `Review GitLab merge request ${ref}: ${title}`,
    "",
    "Read the merge request and its diff:",
    ...commands,
    "",
    "Review the change for correctness, missing tests, and design issues. " +
      "Summarize your findings with file/line references. Do not push " +
      "changes or post to GitLab unless asked.",
  ].join("\n");
}

/**
 * The context a mention attaches. `live` is true when the fields came
 * straight from GitLab; only then are the read commands worth adding.
 */
export function mentionContextText(
  kind: "issue" | "mr",
  project: string,
  iid: number,
  item: { title: string; state: string; author: string; url: string; body: string },
  live: boolean,
): string {
  return [
    `# GitLab ${NOUNS[kind]} ${project}${MARKERS[kind]}${iid}: ${item.title}`,
    "",
    `State: ${item.state} · Author: ${item.author}`,
    `URL: ${item.url}`,
    "",
    item.body.length > 0 ? item.body : "(no description)",
    ...(live
      ? ["", "For full comments/diff run:", ...graphqlReadCommands(kind, project, iid)]
      : []),
  ].join("\n");
}
