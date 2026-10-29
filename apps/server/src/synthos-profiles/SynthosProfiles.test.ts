import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  SYNTHOS_DEFAULT_BUDGET,
  type AuthEnvironmentScope,
  type SynthosProfileInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import migration from "../persistence/Migrations/077_SynthosProfiles.ts";
import * as SynthosProfiles from "./SynthosProfiles.ts";

const actor = {
  sessionId: "desktop-session",
  scopes: ["orchestration:read", "orchestration:operate"] as ReadonlyArray<AuthEnvironmentScope>,
};
const profile = (id = "night-riders"): SynthosProfileInput => ({
  id,
  name: "Night Riders",
  description: "Planning, construction, verification and independent review.",
  bindings: (["architect", "crew", "lead", "reviewer"] as const).map((role) => ({
    role,
    modelSelection: {
      instanceId: ProviderInstanceId.make("provider-fixture"),
      model: `model:${role}`,
    },
    inputTokenLimit: 40000,
    outputTokenLimit: 8000,
  })),
  budget: SYNTHOS_DEFAULT_BUDGET,
  checkCommands: ["vp test run scoped.test.ts"],
});
const fixture = (filename = ":memory:") =>
  SynthosProfiles.layer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename })),
    Layer.provide(NodeServices.layer),
  );

it.effect(
  "preserves named model bindings across reopen and reversible deletion across sessions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "synthos-profiles-" });
      const filename = path.join(directory, "profiles.sqlite");
      yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* SynthosProfiles.SynthosProfiles;
        yield* service.execute(actor, {
          type: "upsert",
          profile: profile(),
          expectedVersion: null,
        });
        yield* service.execute(
          { ...actor, sessionId: "phone-session" },
          {
            type: "upsert",
            profile: { ...profile(), name: "Midnight Crew" },
            expectedVersion: 1,
          },
        );
      }).pipe(Effect.provide(fixture(filename)));
      yield* Effect.gen(function* () {
        const service = yield* SynthosProfiles.SynthosProfiles;
        const loaded = yield* service.execute(actor, { type: "get", id: profile().id });
        expect(loaded.type).toBe("profile");
        if (loaded.type !== "profile") return;
        expect(loaded.profile).toMatchObject({
          name: "Midnight Crew",
          version: 2,
          deleted: false,
          createdBy: "desktop-session",
          updatedBy: "phone-session",
          bindings: profile().bindings,
        });
        yield* service.execute(actor, { type: "delete", id: profile().id, expectedVersion: 2 });
        expect(yield* service.execute(actor, { type: "list" })).toEqual({
          type: "list",
          profiles: [],
          truncated: false,
        });
        const deleted = yield* service.execute(actor, { type: "list", includeDeleted: true });
        expect(deleted.type).toBe("list");
        if (deleted.type !== "list") return;
        expect(deleted.profiles[0]).toMatchObject({ id: profile().id, deleted: true, version: 3 });
        const restored = yield* service.execute(
          { ...actor, sessionId: "cli-session" },
          {
            type: "restore",
            id: profile().id,
            expectedVersion: 3,
          },
        );
        expect(restored.type).toBe("profile");
        if (restored.type !== "profile") return;
        expect(restored.profile).toMatchObject({
          version: 4,
          deleted: false,
          createdBy: "desktop-session",
          updatedBy: "cli-session",
          name: "Midnight Crew",
          bindings: profile().bindings,
        });
      }).pipe(Effect.provide(fixture(filename)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "enforces exact scopes, unique required roles, and version conflicts without losing changes",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const service = yield* SynthosProfiles.SynthosProfiles;
      const write = { type: "upsert" as const, profile: profile(), expectedVersion: null };
      for (const scopes of [[], ["filesystem:write"], ["orchestration:read"]] as const) {
        expect((yield* service.execute({ ...actor, scopes }, write).pipe(Effect.flip)).reason).toBe(
          "forbidden",
        );
      }
      expect(
        (yield* service
          .execute({ ...actor, scopes: ["orchestration:operate"] }, { type: "list" })
          .pipe(Effect.flip)).reason,
      ).toBe("forbidden");
      for (const bindings of [
        [...profile().bindings.slice(0, 3), profile().bindings[0]!],
        profile().bindings.map((binding) =>
          binding.role === "reviewer" ? { ...binding, role: "docs" as const } : binding,
        ),
      ]) {
        expect(
          (yield* service
            .execute(actor, { ...write, profile: { ...profile(), bindings } })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid");
      }
      const unexpected = { ...write, profile: { ...profile(), apiKey: "must-never-persist" } };
      expect((yield* service.execute(actor, unexpected).pipe(Effect.flip)).reason).toBe("invalid");
      yield* service.execute(actor, write);
      expect((yield* service.execute(actor, write).pipe(Effect.flip)).reason).toBe("conflict");
      const results = yield* Effect.forEach(
        ["First edit", "Second edit"],
        (name) =>
          service
            .execute(actor, { ...write, profile: { ...profile(), name }, expectedVersion: 1 })
            .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "saved" })),
        { concurrency: "unbounded" },
      );
      expect(results.toSorted()).toEqual(["conflict", "saved"]);
      expect(
        (yield* service
          .execute(actor, { type: "delete", id: profile().id, expectedVersion: 1 })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(
        (yield* service
          .execute(actor, { type: "restore", id: profile().id, expectedVersion: 2 })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      yield* service.execute(actor, { type: "delete", id: profile().id, expectedVersion: 2 });
      expect(
        (yield* service.execute(actor, { ...write, expectedVersion: 3 }).pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const saved = yield* service.execute(actor, { type: "get", id: profile().id });
      expect(saved.type).toBe("profile");
      if (saved.type !== "profile") return;
      expect(saved.profile).toMatchObject({ version: 3, deleted: true });
      expect(["First edit", "Second edit"]).toContain(saved.profile.name);
    }).pipe(Effect.provide(fixture())),
);

it.effect("bounds profile lists and reports missing records", () =>
  Effect.gen(function* () {
    yield* migration;
    const service = yield* SynthosProfiles.SynthosProfiles;
    for (const id of ["profile-a", "profile-b", "profile-c"]) {
      yield* service.execute(actor, {
        type: "upsert",
        profile: profile(id),
        expectedVersion: null,
      });
    }
    const result = yield* service.execute(actor, { type: "list", limit: 2 });
    expect(result.type).toBe("list");
    if (result.type !== "list") return;
    expect(result.profiles.map((entry) => entry.id)).toEqual(["profile-a", "profile-b"]);
    expect(result.truncated).toBe(true);
    for (const command of [
      { type: "get" as const, id: "missing" },
      { type: "delete" as const, id: "missing", expectedVersion: 1 },
      { type: "restore" as const, id: "missing", expectedVersion: 1 },
    ])
      expect((yield* service.execute(actor, command).pipe(Effect.flip)).reason).toBe("not_found");
  }).pipe(Effect.provide(fixture())),
);
