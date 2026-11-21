import { runSubscriptionPoolTeamScopeContract } from "./subscription-pool-team-scope.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

runSubscriptionPoolTeamScopeContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);
