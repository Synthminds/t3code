import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_policy_snapshots (
    policy_hash TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`;
});
