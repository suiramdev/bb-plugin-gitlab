// `bb gitlab …`: the plugin's CLI for agents and terminals. Every
// subcommand but `sync` reads the cache and project list, never GitLab.
import type { ItemCache } from "./item-cache";
import { isProjectRef } from "./project-ref";

const USAGE = [
  "Usage:",
  "  bb gitlab projects           List tracked GitLab projects",
  "  bb gitlab issues [project]   List cached open issues",
  "  bb gitlab mrs [project]      List cached open merge requests",
  "  bb gitlab sync               Refresh the cache from GitLab now",
  "",
  "A project is written host-qualified: gitlab.com/group/subgroup/app",
].join("\n");

export const GITLAB_CLI_COMMANDS = [
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
];

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

export interface GitlabCliDeps {
  discoverProjects(): Promise<
    Array<{ project: string; bbProjectId: string | null }>
  >;
  cache: ItemCache;
  sync(): Promise<{ projects: number; items: number }>;
}

export async function runGitlabCli(
  argv: string[],
  deps: GitlabCliDeps,
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
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
      const projects = await deps.discoverProjects();
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
      const items = deps.cache.list({
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
      const { projects, items } = await deps.sync();
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
}
