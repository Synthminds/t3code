import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type AuthEnvironmentScope,
  type SynthosGraphSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Projects from "../project/ProjectService.ts";
import migration from "../persistence/Migrations/079_SynthosGraph.ts";
import * as Graph from "./SynthosGraph.ts";
const projectId = ProjectId.make("p1");
const actor = {
  scopes: ["orchestration:read", "orchestration:operate"] as readonly AuthEnvironmentScope[],
};
const layer = Graph.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeedSome({
          id,
          title: "Synthetic graph",
          workspaceRoot: "/fixture",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          deletedAt: null,
        }),
    }),
  ),
  Layer.provide(NodeServices.layer),
);
it.effect(
  "enforces authorization, CAS, private source scope and project isolation across graph imports",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const graph = yield* Graph.SynthosGraph;
      const initial = yield* graph.execute(actor, { type: "settings", projectId });
      expect(initial.settings.autoRecall).toBe(false);
      const settings = {
        ...initial.settings,
        enabledSources: ["synthbrain" as const],
        approvedFolders: ["Projects/A"],
      };
      expect(
        (yield* graph
          .execute({ scopes: ["orchestration:read"] }, { type: "configure", settings })
          .pipe(Effect.flip)).reason,
      ).toBe("forbidden");
      yield* graph.execute(actor, { type: "configure", settings });
      expect(
        (yield* graph.execute(actor, { type: "configure", settings }).pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const imported = yield* graph.execute(actor, {
        type: "import_brain",
        projectId,
        expectedVersion: 1,
        data: {
          nodes: [
            { id: "Projects/A/one.md", title: "One" },
            { id: "Private/secret.md", title: "Hidden" },
          ],
          links: [{ source: "Projects/A/one.md", target: "Private/secret.md", value: 0.8 }],
        },
      });
      expect(imported.nodes.map((n) => n.label)).toEqual(["One"]);
      expect(imported.edges).toEqual([]);
      expect(imported.partial).toBe(true);
      expect((yield* graph.read(ProjectId.make("p2"))).nodes).toEqual([]);
      const selected = yield* graph.execute(actor, {
        type: "select",
        projectId,
        expectedVersion: 2,
        ids: ["synthbrain:Projects/A/one.md"],
      });
      expect(selected.settings.pinned).toHaveLength(1);
      const outside: SynthosGraphSnapshot = {
        source: "synthbrain",
        revision: "r2",
        partial: false,
        nodes: [{ ...imported.nodes[0]!, ref: "Private/secret.md" }],
        edges: [],
      };
      expect(
        (yield* graph
          .execute(actor, { type: "import", projectId, expectedVersion: 3, snapshot: outside })
          .pipe(Effect.flip)).reason,
      ).toBe("forbidden");
      const mission = yield* graph.execute(actor, {
        type: "select",
        projectId,
        workflowId: "mission-a",
        expectedVersion: 3,
        ids: ["synthbrain:Projects/A/one.md"],
      });
      yield* graph.execute(actor, { type: "select", projectId, expectedVersion: 4, ids: [] });
      expect((yield* graph.read(projectId, "mission-a")).settings.pinned).toHaveLength(1);
      expect((yield* graph.read(projectId, "mission-b")).settings.pinned).toHaveLength(0);
      expect((yield* graph.read(projectId, "constructor")).settings.pinned).toHaveLength(0);
      expect(
        (yield* graph.execute(actor, { type: "history", projectId })).history?.map(
          (entry) => entry.version,
        ),
      ).toEqual([1, 2, 3, 4, 5]);
      const disabled = yield* graph.execute(actor, {
        type: "configure",
        settings: { ...mission.settings, version: 5, pinned: [], enabledSources: [] },
      });
      expect(disabled.nodes).toEqual([]);
      expect(disabled.settings.pinned).toHaveLength(0);
      expect(
        (yield* graph
          .execute(actor, {
            type: "refresh",
            projectId,
            expectedVersion: 6,
            query: "private query",
          })
          .pipe(Effect.flip)).reason,
      ).toBe("forbidden");
    }).pipe(Effect.provide(layer), Effect.scoped),
);
