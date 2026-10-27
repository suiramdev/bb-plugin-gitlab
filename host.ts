import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./server/host-contract";
import { createGlab } from "./server/glab";

const glab = createGlab();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async probe() { return { hosts: await glab.authenticatedHosts() }; },
    async graphql({ host, query, variables }) {
      return { json: JSON.stringify(await glab.graphql(host, query, variables)) };
    },
  },
});
