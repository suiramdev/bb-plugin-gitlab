import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { gitlabRpcContract } from "./contract";

type GitlabRpcHandlers = PluginRpcHandlers<typeof gitlabRpcContract>;

function assertGitlabFrontendInference(
  client: PluginRpcClient<typeof gitlabRpcContract>,
) {
  expectTypeOf(
    client.call("getMergeRequest", {
      project: "gitlab.com/group/sub/app",
      iid: 42,
    }),
  ).resolves.toHaveProperty("mergeRequest");

  // @ts-expect-error merge-request iids are numeric.
  void client.call("getIssue", { project: "gitlab.com/group/app", iid: "42" });
  // @ts-expect-error the contract only knows issues and merge requests.
  void client.call("listItems", { kind: "epic" });
}

describe("rpc contract", () => {
  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GitlabRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      project: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGitlabFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitlab-contract",
    });
    const contract = defineRpcContract({
      startReview: gitlabRpcContract.startReview,
    });
    bb.rpc.register(contract, {
      startReview() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startReview", { project: "group", iid: 4 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startReview", {
        project: "gitlab.com/group/sub/app",
        iid: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startReview", {
        project: "gitlab.com/group/sub/app",
        iid: 4,
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
