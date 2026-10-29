import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_tool_probes (tool_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL)`;
});
