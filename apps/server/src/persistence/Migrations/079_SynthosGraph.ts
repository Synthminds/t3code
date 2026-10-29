import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_graph (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL, snapshot_json TEXT NOT NULL)`;
});
