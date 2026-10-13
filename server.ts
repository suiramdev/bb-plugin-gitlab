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
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mentionContextText, spawnPrompt } from "./server/agent-prompts";
import { GITLAB_CLI_COMMANDS, runGitlabCli } from "./server/cli";
import { gitlabRpcContract } from "./server/contract";
import { createGitlabApi } from "./server/gitlab-api";
import { createGlab } from "./server/glab";
import { createItemCache } from "./server/item-cache";
import { fetchProjectItems } from "./server/items";
import {
  isProjectRef,
  normalizeProjectRef,
  parseGitlabRemote,
  parseProjectRef,
  type GitlabHost,
} from "./server/project-ref";

export { gitlabRpcContract };

const SYNC_INTERVAL_MS = 5 * 60_000;

interface ProjectInfo {
  /** "host/group/sub/project" */
  project: string;
  host: string;
  path: string;
  /** The BB project whose remote points at it, when there is one. */
  bbProjectId: string | null;
}

interface ThreadLink {
  kind: "issue" | "mr";
  project: string;
  iid: number;
  threadId: string;
  createdAt: string;
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
  // glab: the binary, its logged-in hosts, and the GitLab API behind it.
  // ------------------------------------------------------------------
  const glab = createGlab();
  let glabAuthError: string | null = "checking glab…";
  let authenticatedHosts: GitlabHost[] = [];

  async function checkAuth(): Promise<void> {
    try {
      authenticatedHosts = await glab.authenticatedHosts();
      glabAuthError = null;
    } catch (error) {
      glabAuthError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  const gitlab = createGitlabApi({
    graphql: glab.graphql,
    defaultHost: () => authenticatedHosts[0]?.host,
    warn: (message) => bb.log.warn(message),
  });

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

  const cache = createItemCache(bb.storage);

  /** Patches a cached row after a mutation so the UI updates right away. */
  function patchCachedItem(
    ...args: Parameters<typeof cache.patch>
  ): void {
    cache.patch(...args);
    bb.realtime.publish("data-changed", {});
  }

  async function syncProject(project: string): Promise<number> {
    const items = await fetchProjectItems(glab.graphql, project);
    cache.replaceProject(project, items);
    return items.length;
  }

  async function syncAll(
    force = false,
  ): Promise<{ projects: number; items: number }> {
    await checkAuth();
    const projects = await discoverProjects(force);
    const before = cache.fingerprint();
    // A project that stopped being tracked — removed from extraProjects, or
    // gone from GitLab — must not keep serving rows to lists and mentions.
    cache.retainProjects(projects.map((entry) => entry.project));
    let total = 0;
    for (const { project } of projects) {
      try {
        total += await syncProject(project);
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
    if (before !== cache.fingerprint()) {
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
    const item = cache.get(kind, project, iid);
    const noun = kind === "mr" ? "merge request" : "issue";
    const marker = kind === "mr" ? "!" : "#";
    const title = item?.title ?? `${noun} ${marker}${iid}`;
    const bbProjectId = await resolveBbProjectId(project);
    const ref = `${project}${marker}${iid}`;
    const thread = await bb.sdk.threads.spawn({
      projectId: bbProjectId,
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      prompt: spawnPrompt(kind, project, iid, title, item?.body ?? null),
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
        items: cache.list({
          kind: input.kind,
          project: input.project,
          state: input.state,
        }),
      };
    },

    /** () → the authenticated glab username, for "assign to me" affordances. */
    async viewer() {
      return { username: await gitlab.viewer() };
    },

    /** { project } → usernames that can be assigned in that project. */
    async assignableUsers(input) {
      const members = await gitlab.members(input.project);
      return {
        users: [...new Set(members)].sort((a, b) => a.localeCompare(b)),
      };
    },

    /** { project } → labels available in that project. */
    async projectLabels(input) {
      return { labels: await gitlab.labels(input.project) };
    },

    /** { project, iid, state } → close or reopen an issue. */
    async setIssueState({ project, iid, state }): Promise<{ ok: true }> {
      const applied = await gitlab.setIssueState(project, iid, state);
      patchCachedItem("issue", project, iid, { state: applied });
      return { ok: true };
    },

    /** { project, iid, assignees } → set the exact assignee list. */
    async setAssignees({
      project,
      iid,
      assignees,
    }): Promise<{ ok: true; assignees: string[] }> {
      const applied = await gitlab.setAssignees(project, iid, assignees);
      patchCachedItem("issue", project, iid, { assignees: applied });
      return { ok: true, assignees: applied };
    },

    /** { project, iid, labels } → set the exact issue label list. */
    async setLabels({
      project,
      iid,
      labels,
    }): Promise<{ ok: true; labels: string[] }> {
      const applied = await gitlab.setLabels(project, iid, labels);
      patchCachedItem("issue", project, iid, { labels: applied });
      return { ok: true, labels: applied };
    },

    /** { project, iid } → live issue detail incl. comments. */
    async getIssue({ project, iid }) {
      return { issue: await gitlab.getIssue(project, iid) };
    },

    /** { project, iid } → full merge-request detail. */
    async getMergeRequest({ project, iid }) {
      return { mergeRequest: await gitlab.getMergeRequest(project, iid) };
    },

    /** { project, iid, body } → add an issue comment. */
    async commentIssue({ project, iid, body }): Promise<{ ok: true }> {
      await gitlab.addNote("issue", project, iid, body);
      return { ok: true };
    },

    /** { project, iid, body } → add a merge-request comment. */
    async commentMergeRequest({ project, iid, body }): Promise<{ ok: true }> {
      await gitlab.addNote("mr", project, iid, body);
      return { ok: true };
    },

    /** { project, title, body? } → create an issue, refresh, return iid+url. */
    async createIssue(input) {
      const created = await gitlab.createIssue(
        input.project,
        input.title,
        input.body ?? "",
      );
      try {
        await syncProject(input.project);
        bb.realtime.publish("data-changed", {});
      } catch {
        // creation succeeded; the next scheduled sync will pick it up
      }
      return created;
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
    return cache.list({ kind, query, state: "open" })
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
    try {
      const detail = await gitlab.getItem(kind, project, iid);
      if (detail === null) {
        throw new Error(`GitLab ${project}${marker}${iid} not found`);
      }
      const item = {
        title: detail.title,
        state: detail.state,
        author: detail.author?.username ?? "",
        url: detail.webUrl,
        body: detail.description,
      };
      return { context: mentionContextText(kind, project, iid, item, true) };
    } catch (error) {
      const cached = cache.get(kind, project, iid);
      if (cached === null) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return { context: mentionContextText(kind, project, iid, cached, false) };
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
  bb.cli.register({
    name: "gitlab",
    summary: "Browse tracked GitLab projects, issues, and merge requests",
    commands: GITLAB_CLI_COMMANDS,
    run(argv) {
      return runGitlabCli(argv, {
        discoverProjects: () => discoverProjects(true),
        cache,
        sync: () => syncAll(true),
      });
    },
  });
}
