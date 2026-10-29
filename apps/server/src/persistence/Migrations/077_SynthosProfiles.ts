import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_profiles (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version > 0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
    updated_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX synthos_profiles_recent ON synthos_profiles(deleted,updated_at,id)`;
});
