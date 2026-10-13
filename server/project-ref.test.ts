import { describe, expect, it } from "vitest";
import {
  isProjectRef,
  normalizeHostname,
  normalizeProjectRef,
  parseGitlabRemote,
  parseProjectRef,
  type GitlabHost,
} from "./project-ref";

/** Hosting shapes glab supports, all keyed by the name it knows them by. */
const PLAIN: GitlabHost = {
  host: "gitlab.com",
  subfolder: "",
  sshHost: null,
  apiHost: null,
};
/** Self-managed, served under https://code.example.dev/gitlab/. */
const SUBFOLDER: GitlabHost = {
  host: "code.example.dev",
  subfolder: "gitlab",
  sshHost: null,
  apiHost: null,
};
/** Self-managed behind a port, with git-over-SSH on its own name. */
const SPLIT: GitlabHost = {
  host: "devops.corp",
  subfolder: "",
  sshHost: "ssh.devops.corp",
  apiHost: "devops.corp:8443",
};
const HOSTS: GitlabHost[] = [PLAIN, SUBFOLDER, SPLIT];

describe("GitLab project refs", () => {
  it("reads a host-qualified ref out of every remote shape", () => {
    expect(parseGitlabRemote("git@gitlab.com:group/sub/app.git", HOSTS)).toBe(
      "gitlab.com/group/sub/app",
    );
    expect(parseGitlabRemote("https://gitlab.com/group/app.git\n", HOSTS)).toBe(
      "gitlab.com/group/app",
    );
    expect(
      parseGitlabRemote("ssh://git@gitlab.com:2222/group/sub/deep/app", HOSTS),
    ).toBe("gitlab.com/group/sub/deep/app");
    // Case and IDN are normalized so one instance is never tracked twice and
    // the ref stays the ASCII name DNS and glab both use.
    expect(parseGitlabRemote("git@GitLab.com:group/app.git", HOSTS)).toBe(
      "gitlab.com/group/app",
    );
    expect(
      parseGitlabRemote("https://xn--gitlb-jra.example/g/a.git", [
        { host: "gitläb.example", subfolder: "", sshHost: null, apiHost: null },
      ]),
    ).toBe("xn--gitlb-jra.example/g/a");
  });

  it("resolves the hosting variants glab describes in its host config", () => {
    // A subfolder is part of the URL but never part of the project path.
    expect(
      parseGitlabRemote("https://code.example.dev/gitlab/group/app.git", HOSTS),
    ).toBe("code.example.dev/group/app");
    // Ports never reach a ref: `glab --hostname` rejects them, and the port
    // belongs to the host's api_host config instead.
    expect(
      parseGitlabRemote("https://devops.corp:8443/team/web/app.git", HOSTS),
    ).toBe("devops.corp/team/web/app");
    // Git over SSH answering on another name still maps to the glab host.
    expect(
      parseGitlabRemote("git@ssh.devops.corp:team/web/app.git", HOSTS),
    ).toBe("devops.corp/team/web/app");
    // A subfolder-shaped path on a host without one stays untouched.
    expect(parseGitlabRemote("https://gitlab.com/gitlab/app.git", HOSTS)).toBe(
      "gitlab.com/gitlab/app",
    );
  });

  it("keeps untracked hosts and namespace-less paths out of discovery", () => {
    expect(parseGitlabRemote("git@github.com:acme/widgets.git", HOSTS)).toBeNull();
    // A user-level path with no namespace is not a project.
    expect(parseGitlabRemote("https://gitlab.com/app.git", HOSTS)).toBeNull();
    // A subfolder install whose remote carries only the subfolder + project.
    expect(
      parseGitlabRemote("https://code.example.dev/gitlab/app.git", HOSTS),
    ).toBeNull();
    expect(parseGitlabRemote("", HOSTS)).toBeNull();
    expect(parseGitlabRemote("git@gitlab.com:group/app.git", [])).toBeNull();
    // IPv6 literals: glab refuses them, so the plugin must not invent a ref.
    expect(normalizeHostname("[2001:db8::1]")).toBeNull();
    expect(normalizeHostname("[2001:db8::1]:8443")).toBeNull();
  });

  it("normalizes whatever a user types into extraProjects", () => {
    // Host-qualified, with scheme, case, port, subfolder and trailing slash.
    expect(
      normalizeProjectRef(
        "HTTPS://Code.Example.DEV/gitlab/group/app/",
        HOSTS,
        "gitlab.com",
      ),
    ).toBe("code.example.dev/group/app");
    expect(
      normalizeProjectRef("devops.corp:8443/team/web/app", HOSTS, "gitlab.com"),
    ).toBe("devops.corp/team/web/app");
    // A bare path takes the configured default host, whatever domain that is.
    expect(normalizeProjectRef("group/app", HOSTS, "gitlab.internal")).toBe(
      "gitlab.internal/group/app",
    );
    // An instance glab does not know yet stays addressable for after login.
    expect(
      normalizeProjectRef("git.new-team.dev/group/app", HOSTS, "gitlab.com"),
    ).toBe("git.new-team.dev/group/app");
    expect(normalizeProjectRef("not a project", HOSTS, "gitlab.com")).toBeNull();
    expect(normalizeProjectRef("   ", HOSTS, "gitlab.com")).toBeNull();
  });

  it("splits a ref at the host, never at every slash", () => {
    expect(parseProjectRef("gitlab.example.dev/group/sub/app")).toEqual({
      host: "gitlab.example.dev",
      path: "group/sub/app",
    });
    expect(() => parseProjectRef("gitlab.com")).toThrow("malformed");
    expect(isProjectRef("gitlab.com/group")).toBe(true);
    expect(isProjectRef("gitlab.com/")).toBe(false);
    expect(isProjectRef("group/app")).toBe(true);
  });
});
