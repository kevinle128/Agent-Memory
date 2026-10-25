import { runModelSourceServiceContract } from "./model-source.service.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

runModelSourceServiceContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);
