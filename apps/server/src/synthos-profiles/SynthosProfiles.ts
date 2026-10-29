import {
  SynthosProfile,
  SynthosProfileCommand,
  SynthosProfileError,
  synthosProfileRequiredScope,
  type AuthEnvironmentScope,
  type SynthosProfileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

interface ProfileActor {
  readonly sessionId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}
export class SynthosProfiles extends Context.Service<
  SynthosProfiles,
  {
    readonly execute: (
      actor: ProfileActor,
      command: SynthosProfileCommand,
    ) => Effect.Effect<SynthosProfileResult, SynthosProfileError>;
  }
>()("t3/synthos-profiles/SynthosProfiles") {}

interface Row {
  readonly snapshot_json: string;
}
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(SynthosProfile));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(SynthosProfile));
const decodeCommand = Schema.decodeEffect(SynthosProfileCommand, { onExcessProperty: "error" });
const isProfileError = Schema.is(SynthosProfileError);
const storageError = (cause: unknown) =>
  isProfileError(cause) ? cause : new SynthosProfileError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const load = Effect.fn("SynthosProfiles.load")(function* (id: string) {
    const [row] = yield* sql<Row>`SELECT snapshot_json FROM synthos_profiles WHERE id = ${id}`;
    return row ? yield* decodeRecord(row.snapshot_json) : undefined;
  });

  const mutate = Effect.fn("SynthosProfiles.mutate")(function* (
    actor: ProfileActor,
    command: Exclude<SynthosProfileCommand, { type: "list" | "get" }>,
  ) {
    const id = command.type === "upsert" ? command.profile.id : command.id;
    const previous = yield* load(id);
    if (command.type !== "upsert" && !previous)
      return yield* new SynthosProfileError({ reason: "not_found" });
    if ((previous?.version ?? null) !== command.expectedVersion)
      return yield* new SynthosProfileError({ reason: "conflict" });
    if (
      (command.type === "delete" && previous?.deleted) ||
      (command.type === "restore" && !previous?.deleted) ||
      (command.type === "upsert" && previous?.deleted)
    )
      return yield* new SynthosProfileError({ reason: "conflict" });
    if (command.type === "upsert") {
      const roles = new Set(command.profile.bindings.map((binding) => binding.role));
      if (
        roles.size !== command.profile.bindings.length ||
        !roles.has("architect") ||
        !roles.has("crew") ||
        !roles.has("lead") ||
        !roles.has("reviewer")
      )
        return yield* new SynthosProfileError({ reason: "invalid" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const profile: SynthosProfile = {
      ...(command.type === "upsert" ? command.profile : previous!),
      version: (previous?.version ?? 0) + 1,
      deleted: command.type === "delete",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      createdBy: previous?.createdBy ?? actor.sessionId,
      updatedBy: actor.sessionId,
    };
    const json = yield* encodeRecord(profile);
    if (new TextEncoder().encode(json).length > 32768)
      return yield* new SynthosProfileError({ reason: "invalid" });
    const rows = previous
      ? yield* sql<{
          id: string;
        }>`UPDATE synthos_profiles SET version = ${profile.version}, deleted = ${profile.deleted ? 1 : 0}, updated_at = ${now}, snapshot_json = ${json} WHERE id = ${id} AND version = ${command.expectedVersion} RETURNING id`
      : yield* sql<{
          id: string;
        }>`INSERT INTO synthos_profiles (id, version, deleted, updated_at, snapshot_json) VALUES (${id}, 1, 0, ${now}, ${json}) ON CONFLICT(id) DO NOTHING RETURNING id`;
    if (rows.length !== 1) return yield* new SynthosProfileError({ reason: "conflict" });
    return { type: "profile" as const, profile };
  });

  const execute = Effect.fn("SynthosProfiles.execute")(function* (
    actor: ProfileActor,
    input: SynthosProfileCommand,
  ): Effect.fn.Return<SynthosProfileResult, SynthosProfileError> {
    const command = yield* decodeCommand(input).pipe(
      Effect.mapError((cause) => new SynthosProfileError({ reason: "invalid", cause })),
    );
    if (!actor.scopes.includes(synthosProfileRequiredScope(command)))
      return yield* new SynthosProfileError({ reason: "forbidden" });
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (command.type === "list") {
            const limit = command.limit ?? 30;
            const rows = yield* sql<Row>`SELECT snapshot_json FROM synthos_profiles
          WHERE ${command.includeDeleted === true ? 1 : 0} = 1 OR deleted = 0
          ORDER BY updated_at DESC, id LIMIT ${limit + 1}`;
            const profiles: SynthosProfile[] = [];
            let bytes = 0;
            for (const row of rows.slice(0, limit)) {
              bytes += new TextEncoder().encode(row.snapshot_json).length;
              if (bytes > 512 * 1024) break;
              profiles.push(yield* decodeRecord(row.snapshot_json));
            }
            return { type: "list" as const, profiles, truncated: rows.length > profiles.length };
          }
          if (command.type === "get") {
            const profile = yield* load(command.id);
            if (!profile) return yield* new SynthosProfileError({ reason: "not_found" });
            return { type: "profile" as const, profile };
          }
          return yield* mutate(actor, command);
        }),
      )
      .pipe(Effect.mapError(storageError));
  });
  return SynthosProfiles.of({ execute });
});

export const layer = Layer.effect(SynthosProfiles, make);
