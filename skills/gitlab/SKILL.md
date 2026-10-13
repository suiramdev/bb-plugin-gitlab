---
name: gitlab
description: Read and act on GitLab issues, merge requests, pipelines, and notes with the glab CLI (GraphQL through `glab api graphql` as the fallback) and the `bb gitlab` command. Use when a task references a GitLab issue (#123), a merge request (!456), a GitLab project path, a pipeline failure, or when opening/updating a merge request.
---

# Working with GitLab

Three tools, in this order:

- `bb gitlab …` — the plugin's cached view across every tracked project. Fast,
  no network, no host flags. Use it to find things.
- `glab …` subcommands (`glab issue`, `glab mr`, `glab ci`) — the GitLab CLI,
  live. Use them to read details and to write whenever one covers the task.
- `glab api graphql …` — the GitLab GraphQL API. Use it only for what the
  subcommands do not cover. Do not call REST endpoints with `glab api <path>`.

## Find work

```sh
bb gitlab projects                       # tracked projects, host-qualified
bb gitlab issues [host/group/project]    # cached open issues
bb gitlab mrs [host/group/project]       # cached open merge requests
bb gitlab sync                           # refresh the cache now
```

A project is always host-qualified — `gitlab.example.dev/group/subgroup/app` —
because a namespace path has any number of segments and the same path may exist
on two instances. Issues print as `<project>#<iid>`, merge requests as
`<project>!<iid>`.

## Read details

```sh
glab issue view <iid> -R <project> --comments
glab mr view <iid> -R <project> --comments
glab mr diff <iid> -R <project>
glab ci status -R <project>              # pipeline for the current branch
```

`-R` accepts the same host-qualified ref `bb gitlab` prints.

For anything the subcommands do not cover, such as inline review threads or
the jobs of a merge request's pipeline, use GraphQL. Split the project ref at
the first `/`: the first part is `--hostname`, the rest is the project's
`fullPath`. Pass the path as written (no URL encoding). `iid` is a string.
`--hostname` takes the bare hostname only — never a scheme, a port, or a path.

```sh
glab api graphql --hostname <host> -f path=group/subgroup/app -f iid=12 -f query='
  query($path: ID!, $iid: String!) {
    project(fullPath: $path) {
      mergeRequest(iid: $iid) {
        discussions { nodes { resolved notes { nodes { body author { username } position { newPath newLine } } } } }
        headPipeline { status jobs { nodes { name status webPath } } }
      }
    }
  }'
```

Notes include GitLab's activity feed; skip notes with `system: true`.

Self-managed instances need nothing extra here. How a host is really reached —
`https` or `http`, a non-default port (`api_host`), a subfolder install
(`subfolder`), a separate SSH name (`ssh_host`), a private CA (`ca_cert`) — is
already in that host's glab config, and glab applies it. Read it, never
hardcode a URL:

```sh
glab config get subfolder --host <host>   # e.g. "gitlab" for https://example.com/gitlab/
glab config get api_host --host <host>    # e.g. "example.com:8443"
glab auth status --hostname <host>        # prints the resolved GraphQL endpoint
```

## Write

Prefer `glab` subcommands; they set the right defaults.

```sh
glab mr create --fill --target-branch <base> -R <project>
glab mr note <iid> -R <project> -m "message"
glab issue note <iid> -R <project> -m "message"
glab issue close <iid> -R <project>
```

When no subcommand covers the change, use a GraphQL mutation. Pass text with
`-f` (sent verbatim) and input objects with `-F` as JSON. GitLab reports a
refused mutation in the payload's `errors`, so always select `errors` and check
that it is empty:

```sh
glab api graphql --hostname <host> \
  -F 'input={"projectPath":"group/app","iid":"7","assigneeUsernames":["tanuki"],"operationMode":"REPLACE"}' \
  -f query='mutation($input: IssueSetAssigneesInput!) { issueSetAssignees(input: $input) { errors } }'
```

## GitLab vocabulary that changes behavior

- Merge request, never pull request. Close an issue from an MR description with
  `Closes #7` (`Fixes #7` is GitHub-only and does nothing on GitLab).
- States are `opened`, `closed`, `merged`, `locked`; draft is a separate flag,
  set by a `Draft:` title prefix.
- `iid` is the per-project number a human quotes; `id` is the instance-wide id
  the API also accepts (in GraphQL, a global id such as
  `gid://gitlab/Issue/42`). Always pass `iid`: to the subcommands, and to
  `issue(iid:)` and `mergeRequest(iid:)` in GraphQL.
- Mergeability lives in `detailedMergeStatus` (`MERGEABLE`, `NEED_REBASE`,
  `CI_MUST_PASS`, …), not in a boolean.
- CI is a pipeline of jobs. A `manual` or `skipped` job is not a failure.
- Approvals replace reviews: `approvalsLeft` is the gate to watch.

## Do not

- Do not push, comment, approve, merge, or close anything the user did not ask
  for. Reviewing means reporting findings.
- Do not run `glab auth login` — the plugin reports an unauthenticated host and
  the user fixes it.
