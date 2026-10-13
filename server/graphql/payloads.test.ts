import { describe, expect, it } from "vitest";
import { graphqlData, mutationPayload } from "./payloads";

describe("GitLab GraphQL responses", () => {
  it("unwraps data and turns GraphQL errors into one rejection", () => {
    expect(graphqlData({ data: { currentUser: { username: "tanuki" } } })).toEqual({
      currentUser: { username: "tanuki" },
    });
    expect(() =>
      graphqlData({
        errors: [
          { message: "Field 'nope' doesn't exist on type 'Project'" },
          { message: "second" },
        ],
      }),
    ).toThrow("Field 'nope' doesn't exist on type 'Project'; second");
    expect(() => graphqlData("<html>")).toThrow("malformed");
  });

  it("rejects a mutation GitLab refused in its payload", () => {
    expect(
      mutationPayload({ createNote: { errors: [] } }, "createNote"),
    ).toEqual({ errors: [] });
    expect(() =>
      mutationPayload(
        { updateIssue: { errors: ["You do not have permission"], issue: null } },
        "updateIssue",
      ),
    ).toThrow("You do not have permission");
    expect(() => mutationPayload({ createIssue: null }, "createIssue")).toThrow(
      "returned no result",
    );
  });
});
