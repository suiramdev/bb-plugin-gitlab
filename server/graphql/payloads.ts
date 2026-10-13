// GitLab GraphQL payloads. These come off the network, so every field is
// parsed with a fallback: one odd node must never take down a list or a
// detail view.
import { z } from "zod";

/** A GraphQL connection's nodes, with unreadable nodes kept as null. */
export function connectionOf<T extends z.ZodType>(node: T) {
  return z
    .looseObject({ nodes: z.array(node.nullable().catch(null)).catch([]) })
    .nullish()
    .catch(null);
}

/** The readable nodes of a connection parsed by connectionOf. */
export function nodesOf<T>(connection: { nodes: Array<T | null> } | null | undefined): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node !== null);
}

/** GraphQL sends some booleans (the Diff flags) as "true"/"false" strings. */
export const looseBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
  .catch(false);

export const gitlabUserNodeSchema = z.looseObject({
  username: z.string().catch(""),
});
export const gitlabLabelNodeSchema = z.looseObject({
  id: z.string().catch(""),
  title: z.string().catch(""),
});
export const gitlabItemNodeSchema = z.looseObject({
  // GraphQL types iid as a string.
  iid: z.coerce.number().int().positive(),
  title: z.string().catch(""),
  state: z.string().catch("opened"),
  draft: z.boolean().catch(false),
  author: gitlabUserNodeSchema.nullish().catch(null),
  labels: connectionOf(gitlabLabelNodeSchema),
  assignees: connectionOf(gitlabUserNodeSchema),
  webUrl: z.string().catch(""),
  description: z.string().catch(""),
  updatedAt: z.string().catch(""),
});
export const gitlabNoteNodeSchema = z.looseObject({
  body: z.string().catch(""),
  system: z.boolean().catch(false),
  createdAt: z.string().catch(""),
  author: gitlabUserNodeSchema.nullish().catch(null),
  position: z
    .looseObject({
      newPath: z.string().nullable().catch(null),
      oldPath: z.string().nullable().catch(null),
      newLine: z.number().int().nullable().catch(null),
      oldLine: z.number().int().nullable().catch(null),
    })
    .nullish()
    .catch(null),
});
export const gitlabIssueDetailSchema = gitlabItemNodeSchema.extend({
  notes: connectionOf(gitlabNoteNodeSchema),
});
export const gitlabMergeRequestDetailSchema = gitlabItemNodeSchema.extend({
  createdAt: z.string().catch(""),
  sourceBranch: z.string().catch(""),
  targetBranch: z.string().catch(""),
  conflicts: z.boolean().catch(false),
  detailedMergeStatus: z.string().nullable().catch(null),
  reviewers: connectionOf(gitlabUserNodeSchema),
  diffStatsSummary: z
    .looseObject({
      additions: z.number().int().nonnegative().catch(0),
      deletions: z.number().int().nonnegative().catch(0),
      fileCount: z.number().int().nonnegative().catch(0),
    })
    .nullish()
    .catch(null),
  diffStats: z
    .array(
      z.looseObject({
        path: z.string().catch(""),
        additions: z.number().int().nonnegative().catch(0),
        deletions: z.number().int().nonnegative().catch(0),
      }),
    )
    .catch([]),
  headPipeline: z
    .looseObject({
      status: z.string().catch(""),
      path: z.string().catch(""),
    })
    .nullish()
    .catch(null),
  notes: connectionOf(gitlabNoteNodeSchema),
});
export const gitlabDiscussionsSchema = connectionOf(
  z.looseObject({
    resolvable: z.boolean().catch(false),
    resolved: z.boolean().catch(false),
    notes: connectionOf(gitlabNoteNodeSchema),
  }),
);
export const gitlabDiffsSchema = z
  .looseObject({
    pageInfo: z
      .looseObject({ hasNextPage: z.boolean().catch(false) })
      .catch({ hasNextPage: false }),
    nodes: z
      .array(
        z.looseObject({
          oldPath: z.string().nullable().catch(null),
          newPath: z.string().nullable().catch(null),
          newFile: looseBooleanSchema,
          deletedFile: looseBooleanSchema,
          renamedFile: looseBooleanSchema,
          diff: z.string().catch(""),
        }),
      )
      .catch([]),
  })
  .nullish()
  .catch(null);
export const gitlabJobsSchema = connectionOf(
  z.looseObject({
    name: z.string().catch("job"),
    status: z.string().catch(""),
    webPath: z.string().catch(""),
  }),
);
export const gitlabApprovalsSchema = z
  .looseObject({
    approvalsRequired: z.number().int().nonnegative().catch(0),
    approvalsLeft: z.number().int().nonnegative().catch(0),
    approvedBy: connectionOf(gitlabUserNodeSchema),
  })
  .catch({ approvalsRequired: 0, approvalsLeft: 0, approvedBy: null });
export const gitlabMutationErrorsSchema = z
  .looseObject({ errors: z.array(z.string()).catch([]) })
  .nullish()
  .catch(null);
export const graphqlResponseSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z
    .array(z.looseObject({ message: z.string().catch("unknown error") }))
    .optional()
    .catch(undefined),
});

/** A `{ project(fullPath:) { … } }` result; a missing project parses as null. */
export function projectResultOf<T extends z.ZodType>(project: T) {
  return z
    .looseObject({ project: project.nullish().catch(null) })
    .catch({ project: null });
}

/** A `project { item: issue|mergeRequest(iid:) { … } }` result. */
export function itemResultOf<T extends z.ZodType>(item: T) {
  return projectResultOf(z.looseObject({ item: item.nullish().catch(null) }));
}

export const issueDetailResultSchema = itemResultOf(gitlabIssueDetailSchema);
export const mergeRequestDetailResultSchema = itemResultOf(
  gitlabMergeRequestDetailSchema,
);
export const itemDetailResultSchema = itemResultOf(gitlabItemNodeSchema);
export const mergeRequestDiscussionsSchema = z
  .looseObject({ discussions: gitlabDiscussionsSchema })
  .catch({ discussions: null });
export const mergeRequestDiffsSchema = z
  .looseObject({ diffs: gitlabDiffsSchema })
  .catch({ diffs: null });
export const mergeRequestJobsSchema = z
  .looseObject({
    headPipeline: z
      .looseObject({ jobs: gitlabJobsSchema })
      .nullish()
      .catch(null),
  })
  .catch({ headPipeline: null });
export const updatedIssueSchema = z
  .looseObject({
    issue: z
      .looseObject({
        state: z.string().optional().catch(undefined),
        labels: connectionOf(gitlabLabelNodeSchema),
        assignees: connectionOf(gitlabUserNodeSchema),
      })
      .nullish()
      .catch(null),
  })
  .catch({ issue: null });
export const createdIssueSchema = z
  .looseObject({
    issue: z
      .looseObject({
        iid: z.coerce.number().int().positive().nullable().catch(null),
        webUrl: z.string().catch(""),
      })
      .nullish()
      .catch(null),
  })
  .catch({ issue: null });

/** The `project.item` object of an itemQuery result, unparsed. */
export function itemOf(data: unknown): unknown {
  return z
    .looseObject({
      project: z.looseObject({ item: z.unknown() }).nullish().catch(null),
    })
    .catch({ project: null })
    .parse(data).project?.item;
}

export type GitlabUserNode = z.infer<typeof gitlabUserNodeSchema>;
export type GitlabItemNode = z.infer<typeof gitlabItemNodeSchema>;
export type GitlabNoteNode = z.infer<typeof gitlabNoteNodeSchema>;

/** The `data` of a GraphQL response, or an error carrying its messages. */
export function graphqlData(raw: unknown): unknown {
  const parsed = graphqlResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed GitLab GraphQL response");
  const { data, errors } = parsed.data;
  if (errors !== undefined && errors.length > 0) {
    throw new Error(
      `GitLab GraphQL error: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return data ?? null;
}

/**
 * The payload of mutation `field`. GitLab reports refused mutations (bad
 * input, missing permission) in the payload's `errors`, not as GraphQL errors.
 */
export function mutationPayload(data: unknown, field: string): unknown {
  const payload =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)[field]
      : undefined;
  if (payload == null) throw new Error(`GitLab ${field} returned no result`);
  const errors = gitlabMutationErrorsSchema.parse(payload)?.errors ?? [];
  if (errors.length > 0) {
    throw new Error(`GitLab ${field} failed: ${errors.join("; ")}`);
  }
  return payload;
}

export const viewerResultSchema = z
  .looseObject({ currentUser: gitlabUserNodeSchema.nullish().catch(null) })
  .catch({ currentUser: null });
export const membersResultSchema = projectResultOf(
  z.looseObject({
    projectMembers: connectionOf(
      z.looseObject({ user: gitlabUserNodeSchema.nullish().catch(null) }),
    ),
  }),
);
export const labelsResultSchema = projectResultOf(
  z.looseObject({
    labels: z
      .looseObject({
        pageInfo: z
          .looseObject({
            hasNextPage: z.boolean().catch(false),
            endCursor: z.string().nullable().catch(null),
          })
          .catch({ hasNextPage: false, endCursor: null }),
        nodes: z.array(gitlabLabelNodeSchema.nullable().catch(null)).catch([]),
      })
      .nullish()
      .catch(null),
  }),
);
export type LabelsConnection = NonNullable<
  z.infer<typeof labelsResultSchema>["project"]
>["labels"];
export const itemIdResultSchema = projectResultOf(
  z.looseObject({
    item: z.looseObject({ id: z.string().min(1) }).nullish().catch(null),
  }),
);
