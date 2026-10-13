// Project refs: "host/group/sub/project", and how git remotes and
// user-written entries map onto them for the hosts glab knows.

/**
 * "host/group/sub/project" — the host glab knows the instance by, then a path
 * of 1+ namespace segments. No port and no scheme: `glab --hostname` accepts a
 * bare hostname only, and everything else about how an instance is reached
 * (port, subfolder, http, alternate SSH host, custom CA) lives in that host's
 * glab config. Underscores appear in intranet hostnames, which glab accepts.
 */
export const PROJECT_REF_PATTERN =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

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
