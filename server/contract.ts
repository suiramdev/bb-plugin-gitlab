// The rpc contract: what the frontend panel may ask the server for.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROJECT_REF_PATTERN } from "./project-ref";

const projectRefSchema = z.string().regex(PROJECT_REF_PATTERN);
const iidSchema = z.number().int().positive();
const itemInputSchema = z
  .object({ project: projectRefSchema, iid: iidSchema })
  .strict();
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const projectInfoSchema = z
  .object({
    project: projectRefSchema,
    host: z.string().min(1),
    path: z.string().min(1),
    bbProjectId: z.string().nullable(),
  })
  .strict();
const itemSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    kind: z.enum(["issue", "mr"]),
    title: z.string(),
    /** GitLab-native: "opened" | "closed" | "merged" | "locked". */
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z
  .object({
    projects: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const noteSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();
const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "mr"]),
    project: projectRefSchema,
    iid: iidSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
const mergeRequestSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    title: z.string(),
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    /** GitLab's totals for the whole merge request, even when files is partial. */
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /** GitLab's own total, which can exceed files.length. */
    changedFiles: z.number().int().nonnegative(),
    /** True when the diff list stopped at the page limit, so files is partial. */
    filesTruncated: z.boolean(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewers: z.array(z.string()),
    /** GitLab's detailedMergeStatus lowercased, e.g. "mergeable", "need_rebase". */
    mergeStatus: z.string(),
    hasConflicts: z.boolean(),
    approvalsRequired: z.number().int().nonnegative(),
    approvalsLeft: z.number().int().nonnegative(),
    approvedBy: z.array(z.string()),
    pipeline: z
      .object({ status: z.string(), url: z.string() })
      .strict()
      .nullable(),
    jobs: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["success", "failure", "pending", "neutral"]),
          rawStatus: z.string(),
          url: z.string(),
        })
        .strict(),
    ),
    notes: z.array(noteSchema),
    discussions: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          resolved: z.boolean(),
          notes: z.array(noteSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const gitlabRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        glabOk: z.boolean(),
        glabError: z.string().nullable(),
        hosts: z.array(z.string()),
        projects: z.array(projectInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "mr"]).optional(),
        project: projectRefSchema.optional(),
        state: z.enum(["open", "closed"]).optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ username: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  projectLabels: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ labels: z.array(z.string().min(1)) }).strict(),
  },
  setIssueState: {
    input: itemInputSchema
      .extend({ state: z.enum(["open", "closed"]) })
      .strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema
      .extend({ assignees: z.array(z.string().min(1)) })
      .strict(),
    output: z
      .object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) })
      .strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z
      .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
      .strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            project: projectRefSchema,
            iid: iidSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            notes: z.array(noteSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getMergeRequest: {
    input: itemInputSchema,
    output: z.object({ mergeRequest: mergeRequestSchema }).strict(),
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  commentMergeRequest: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        project: projectRefSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z.object({ iid: iidSchema.nullable(), url: z.string() }).strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  mergeRequestForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ mergeRequest: itemInputSchema.nullable() }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z
      .object({ links: z.record(z.string(), z.array(threadLinkSchema)) })
      .strict(),
  },
});

export type MergeRequestDetail = z.infer<typeof mergeRequestSchema>;
export type Note = z.infer<typeof noteSchema>;
