import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const gitlabHost = z.object({
  host: z.string(), subfolder: z.string(),
  sshHost: z.string().nullable(), apiHost: z.string().nullable(),
});

export const hostContract = defineRpcContract({
  probe: { input: z.null(), output: z.object({ hosts: z.array(gitlabHost) }), experimental_retryable: true },
  graphql: {
    input: z.object({ host: z.string(), query: z.string(), variables: z.record(z.string(), z.json()) }).strict(),
    output: z.object({ json: z.string() }),
  },
});
