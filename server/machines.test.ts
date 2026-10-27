import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

describe("machine aggregation", () => {
  it("unions projects across hosts, retains offline data and routes mutations explicitly", async () => {
    let secondOnline = true;
    const writes: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitlab", experimental_hostEntry: true,
      settings: { extraProjects: "gitlab.com/group/app", defaultHost: "gitlab.com" },
      experimental_callHostRpc: async ({ hostId, method, input }) => {
        if (method === "probe") return { hosts: [{ host: "gitlab.com", subfolder: "", sshHost: null, apiHost: null }] };
        const { query } = input as { query: string };
        if (/^\s*mutation/.test(query)) { writes.push(hostId); return { json: JSON.stringify({ createNote: { errors: [] } }) }; }
        if (!query.includes("GitlabSync")) return { json: JSON.stringify({ project: { issue: { id: "gid://gitlab/Issue/1" } } }) };
        const items = hostId === "one"
          ? [{ iid: "1", title: "old", state: "opened", updatedAt: "2026-01-01" }]
          : [{ iid: "1", title: "new", state: "opened", updatedAt: "2026-01-02" }, { iid: "2", title: "second", state: "opened", updatedAt: "2026-01-02" }];
        return { json: JSON.stringify({ project: { openIssues: { nodes: items }, closedIssues: null, openMergeRequests: null, closedMergeRequests: null, mergedMergeRequests: null } }) };
      },
    });
    harness.sdk.stub("hosts.list", async () => [
      makeHostResponse({ id: "one", name: "One", status: "connected" }),
      makeHostResponse({ id: "two", name: "Two", status: secondOnline ? "connected" : "disconnected" }),
    ]);
    harness.sdk.stub("projects.list", async () => []);
    await plugin(bb);
    await harness.callRpc("refresh", null);
    const titles = async () => (await harness.callRpc("listItems", {}) as { items: Array<{ title: string }> }).items.map(item => item.title).sort();
    expect(await titles()).toEqual(["new", "second"]);
    await harness.callRpc("selectMachine", { hostId: "two" });
    secondOnline = false;
    await harness.callRpc("refresh", null);
    expect(await titles()).toEqual(["new", "second"]);
    await expect(harness.callRpc("commentIssue", { project: "gitlab.com/group/app", iid: 1, body: "hello" })).rejects.toThrow();
    expect(writes).toEqual([]);
    await harness.dispose();
  });
});
