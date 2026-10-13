// The GitLab CLI: finding the binary, running it, reading which hosts it is
// logged in to and how each is reached, and sending GraphQL through
// `glab api graphql`. Every GitLab request the plugin makes goes through here.
import { execFile } from "node:child_process";
import { graphqlData } from "./graphql/payloads";
import { normalizeHostname, type GitlabHost } from "./project-ref";

export const GLAB_HINT =
  "Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run " +
  "`glab auth login`, then `bb plugin reload gitlab`.";

/**
 * Runs one GraphQL request through `glab api graphql` on a glab host and
 * resolves to the response's `data`. GraphQL errors reject.
 */
export type GitlabGraphql = (
  host: string,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;

export interface Glab {
  graphql: GitlabGraphql;
  /**
   * Hosts glab is logged in to, each with its glab host config. Rejects with
   * a NeedsConfigurationError when glab is missing or logged in nowhere.
   */
  authenticatedHosts(): Promise<GitlabHost[]>;
}

/** An error that flips the plugin to needs-configuration, not crashed. */
export function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
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

export function createGlab(): Glab {
  // The server process may have a trimmed PATH, so probe common install
  // locations once and remember the winner.
  let glabPath: string | null = null;

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
  const graphql: GitlabGraphql = async (host, query, variables = {}) => {
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

  async function authenticatedHosts(): Promise<GitlabHost[]> {
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
      throw needsConfiguration(
        `GitLab CLI is not authenticated with any host. ${GLAB_HINT}`,
      );
    }
    return await Promise.all(hosts.map(readHostConfig));
  }

  return { graphql, authenticatedHosts };
}
