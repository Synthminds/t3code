import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_workflows (
    workflow_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX synthos_workflows_status ON synthos_workflows(status, updated_at)`;
  yield* sql`CREATE TABLE synthos_workflow_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES synthos_workflows(workflow_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX synthos_workflow_events_run ON synthos_workflow_events(workflow_id, sequence)`;
  yield* sql`CREATE TABLE synthos_workflow_receipts (
    command_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL
  )`;
});
