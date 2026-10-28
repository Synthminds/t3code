import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE synthos_mail_outbox (
    id TEXT PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'pending', 'sent', 'unknown', 'rejected')),
    message_id TEXT,
    thread_id TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX synthos_mail_outbox_owner ON synthos_mail_outbox(owner_session_id, created_at DESC)`;
  yield* sql`CREATE TABLE synthos_device_intake (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source, source_id)
  )`;
});
