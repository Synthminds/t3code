import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  type AuthEnvironmentScope,
  type SynthosKnowledgeNodeInput,
  type SynthosKnowledgeEdgeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/076_SynthosKnowledge.ts";
import * as SynthosKnowledge from "./SynthosKnowledge.ts";

const actor = {
  sessionId: "desktop-session",
  scopes: ["orchestration:read", "orchestration:operate"] as ReadonlyArray<AuthEnvironmentScope>,
};
const source = {
  kind: "manual" as const,
  ref: "operator-note:project-history",
  sensitivity: "local_only" as const,
  version: "source-v1",
};
const node = (id: string): SynthosKnowledgeNodeInput => ({
  id,
  nodeType: "note",
  label: id,
  body: "Source-backed observation",
  layer: "reasoning",
  provenance: "manual",
  rationale: "Entered by the operator",
  sourceRefs: [source],
});
const edge = (id: string, sourceId: string, targetId: string): SynthosKnowledgeEdgeInput => ({
  id,
  sourceId,
  targetId,
  kind: "references",
  weight: 1,
  provenance: "extracted",
  rationale: "The first note explicitly cites the second",
  sourceRefs: [source],
});
const fixture = (filename = ":memory:") =>
  SynthosKnowledge.layer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename })),
    Layer.provide(NodeServices.layer),
  );

it.effect(
  "persists explicit provenance and corrections across reopen and different client sessions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "synthos-knowledge-" });
      const filename = path.join(directory, "graph.sqlite");
      yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* SynthosKnowledge.SynthosKnowledge;
        yield* service.execute(actor, {
          type: "node.upsert",
          node: node("note-a"),
          expectedVersion: null,
        });
        yield* service.execute(actor, {
          type: "node.upsert",
          node: node("note-b"),
          expectedVersion: null,
        });
        yield* service.execute(actor, {
          type: "edge.upsert",
          edge: edge("edge-ab", "note-a", "note-b"),
          expectedVersion: null,
        });
        const updated = yield* service.execute(
          { ...actor, sessionId: "phone-session" },
          {
            type: "node.upsert",
            node: { ...node("note-a"), body: "Corrected observation" },
            expectedVersion: 1,
            correctionReason: "The source date was corrected",
          },
        );
        expect(updated.type).toBe("node");
        if (updated.type !== "node") return;
        expect(updated.node).toMatchObject({
          version: 2,
          supersedesVersion: 1,
          createdBy: "desktop-session",
          updatedBy: "phone-session",
          ownerId: "environment",
        });
      }).pipe(Effect.provide(fixture(filename)));
      yield* Effect.gen(function* () {
        const service = yield* SynthosKnowledge.SynthosKnowledge;
        const graph = yield* service.execute(
          { ...actor, sessionId: "cli-session" },
          { type: "graph", focusId: "note-a" },
        );
        expect(graph.type).toBe("graph");
        if (graph.type !== "graph") return;
        expect(graph.nodes.map((entry) => entry.id)).toEqual(["note-a", "note-b"]);
        expect(graph.edges).toHaveLength(1);
        expect(graph.edges[0]).toMatchObject({ provenance: "extracted", sourceRefs: [source] });
        const history = yield* service.execute(actor, {
          type: "history",
          entity: "node",
          id: "note-a",
        });
        expect(history.type).toBe("history");
        if (history.type !== "history") return;
        expect(history.revisions.map((entry) => entry.version)).toEqual([2, 1]);
        expect(history.revisions[0]).toMatchObject({ body: "Corrected observation" });
        expect(history.revisions[1]).toMatchObject({ body: "Source-backed observation" });
      }).pipe(Effect.provide(fixture(filename)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "requires exact read/operate scopes and rejects stale or incomplete corrections atomically",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const service = yield* SynthosKnowledge.SynthosKnowledge;
      const write = { type: "node.upsert" as const, node: node("note-a"), expectedVersion: null };
      for (const scopes of [[], ["orchestration:read"], ["filesystem:write"]] as ReadonlyArray<
        ReadonlyArray<AuthEnvironmentScope>
      >) {
        const denied = yield* service.execute({ ...actor, scopes }, write).pipe(Effect.flip);
        expect(denied.reason).toBe("forbidden");
      }
      expect(
        (yield* service
          .execute({ ...actor, scopes: ["orchestration:operate"] }, { type: "graph" })
          .pipe(Effect.flip)).reason,
      ).toBe("forbidden");
      expect(
        (yield* service.execute(actor, { ...write, correctionReason: "   " }).pipe(Effect.flip))
          .reason,
      ).toBe("invalid");
      yield* service.execute(actor, write);
      expect(
        (yield* service.execute(actor, { ...write, expectedVersion: 1 }).pipe(Effect.flip)).reason,
      ).toBe("invalid");
      expect(
        (yield* service
          .execute(actor, { ...write, expectedVersion: 2, correctionReason: "stale" })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(
        (yield* service
          .execute(actor, {
            type: "edge.upsert",
            edge: edge("dangling", "note-a", "missing"),
            expectedVersion: null,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("missing_endpoint");
      const sql = yield* SqlClient.SqlClient;
      const counts = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM synthos_knowledge_revisions`;
      expect(counts[0]?.count).toBe(1);
      const raced = yield* Effect.forEach(
        ["phone", "cli"],
        (sessionId) =>
          service
            .execute(
              { ...actor, sessionId },
              {
                ...write,
                expectedVersion: 1,
                correctionReason: `Correction from ${sessionId}`,
              },
            )
            .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "saved" })),
        { concurrency: "unbounded" },
      );
      expect([...raced].sort()).toEqual(["conflict", "saved"]);
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "retains delete history, hides dangling edges, and restores only with a versioned correction",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const service = yield* SynthosKnowledge.SynthosKnowledge;
      for (const id of ["a", "b"])
        yield* service.execute(actor, {
          type: "node.upsert",
          node: node(id),
          expectedVersion: null,
        });
      yield* service.execute(actor, {
        type: "edge.upsert",
        edge: {
          ...edge("ab", "a", "b"),
          provenance: "inferred",
          weight: 0.3,
          rationale: "Operator hypothesis; not an observed fact",
        },
        expectedVersion: null,
      });
      const deleted = yield* service.execute(actor, {
        type: "delete",
        entity: "node",
        id: "b",
        expectedVersion: 1,
        reason: "Withdraw unsupported note",
      });
      expect(deleted.type === "node" && deleted.node.deleted).toBe(true);
      const graph = yield* service.execute(actor, { type: "graph" });
      expect(graph.type === "graph" && graph.nodes.length).toBe(1);
      expect(graph.type === "graph" && graph.edges.length).toBe(0);
      expect(
        (yield* service.execute(actor, { type: "graph", focusId: "b" }).pipe(Effect.flip)).reason,
      ).toBe("not_found");
      const history = yield* service.execute(actor, {
        type: "history",
        entity: "node",
        id: "b",
        limit: 1,
      });
      expect(history.type === "history" && history.truncated).toBe(true);
      yield* service.execute(actor, {
        type: "node.upsert",
        node: node("b"),
        expectedVersion: 2,
        correctionReason: "Verified and restored source",
      });
      const restored = yield* service.execute(actor, { type: "graph", focusId: "a" });
      expect(restored.type === "graph" && restored.edges[0]?.provenance).toBe("inferred");
    }).pipe(Effect.provide(fixture())),
);

it.effect("bounds cyclic neighborhoods and validates limits before reading storage", () =>
  Effect.gen(function* () {
    yield* migration;
    const service = yield* SynthosKnowledge.SynthosKnowledge;
    for (const id of ["a", "b", "c", "d"])
      yield* service.execute(actor, { type: "node.upsert", node: node(id), expectedVersion: null });
    for (const [id, from, to] of [
      ["ab", "a", "b"],
      ["bc", "b", "c"],
      ["ca", "c", "a"],
      ["cd", "c", "d"],
    ] as const) {
      yield* service.execute(actor, {
        type: "edge.upsert",
        edge: edge(id, from, to),
        expectedVersion: null,
      });
    }
    const zero = yield* service.execute(actor, { type: "graph", focusId: "a", hops: 0 });
    expect(zero.type === "graph" && zero.nodes.map((entry) => entry.id)).toEqual(["a"]);
    const bounded = yield* service.execute(actor, {
      type: "graph",
      focusId: "a",
      hops: 2,
      limit: 2,
    });
    expect(bounded.type).toBe("graph");
    if (bounded.type !== "graph") return;
    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    const ids = new Set(bounded.nodes.map((entry) => entry.id));
    expect(bounded.edges.every((entry) => ids.has(entry.sourceId) && ids.has(entry.targetId))).toBe(
      true,
    );
    expect(
      (yield* service.execute(actor, { type: "graph", limit: 1000 }).pipe(Effect.flip)).reason,
    ).toBe("invalid");
    const matched = yield* service.execute(actor, { type: "graph", query: "d" });
    expect(matched.type === "graph" && matched.nodes.map((entry) => entry.id)).toEqual(["d"]);
  }).pipe(Effect.provide(fixture())),
);
