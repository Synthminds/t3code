import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_knowledge_entities (
    id TEXT PRIMARY KEY,
    entity TEXT NOT NULL CHECK(entity IN ('node','edge')),
    version INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    source_id TEXT,
    target_id TEXT,
    updated_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX synthos_knowledge_recent ON synthos_knowledge_entities(entity,deleted,updated_at,id)`;
  yield* sql`CREATE INDEX synthos_knowledge_source ON synthos_knowledge_entities(source_id,deleted,id)`;
  yield* sql`CREATE INDEX synthos_knowledge_target ON synthos_knowledge_entities(target_id,deleted,id)`;
  yield* sql`CREATE TABLE synthos_knowledge_revisions (
    id TEXT NOT NULL REFERENCES synthos_knowledge_entities(id),
    version INTEGER NOT NULL,
    entity TEXT NOT NULL CHECK(entity IN ('node','edge')),
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY(id,version)
  )`;
});
