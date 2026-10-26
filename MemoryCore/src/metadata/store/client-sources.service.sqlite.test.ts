import { runClientSourcesServiceContract } from "./client-sources.service.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

runClientSourcesServiceContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);
