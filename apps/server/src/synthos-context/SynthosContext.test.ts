import * as Graph from "../synthos-graph/SynthosGraph.ts";
import { sealManifest } from "./manifest.ts";
import type { SynthosGraphResult } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type AuthEnvironmentScope,
  type SynthosContextSettingsInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import migration from "../persistence/Migrations/078_SynthosContext.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Vault from "../synthos-connections/ObsidianVault.ts";
import * as SynthosContext from "./SynthosContext.ts";

const projectId = ProjectId.make("project:context");
const actor = {
  scopes: ["orchestration:read", "orchestration:operate"] as ReadonlyArray<AuthEnvironmentScope>,
};
const defaults: SynthosContextSettingsInput = {
  autoRecall: false,
  approvedNotes: [],
  projectFolders: [],
  neighborhoodFolders: [],
  pinnedNotes: [],
  excludedPaths: [],
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "synthos-context-" });
  const repository = path.join(directory, "repository");
  const vaultRoot = path.join(directory, "vault");
  yield* fs.makeDirectory(repository);
  yield* fs.makeDirectory(vaultRoot);
  yield* fs.writeFileString(
    path.join(repository, "ROUTING.md"),
    '```json\n{"version":1,"routes":[{"id":"memory","keywords":["obsidian"],"roles":[],"paths":["memory"],"load":["CONTEXT.md"],"skip":[]}]}\n```',
  );
  yield* fs.writeFileString(
    path.join(repository, "CONTEXT.md"),
    "# Local constraints\n\nPreserve source provenance.",
  );
  const layer = SynthosContext.layer.pipe(
    Layer.provideMerge(
      NodeSqliteClient.layer({ filename: path.join(directory, "context.sqlite") }),
    ),
    Layer.provide(Vault.layer({ vaultRoot })),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  id,
                  title: "Context fixture",
                  workspaceRoot: repository,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const writeNote = (name: string, content: string) =>
    Effect.gen(function* () {
      const target = path.join(vaultRoot, name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    });
  return { fs, path, repository, vaultRoot, layer, writeNote };
});

it.effect(
  "persists project settings across reopen and rejects stale or unauthorized mutations",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* SynthosContext.SynthosContext;
        const initial = yield* service.execute(actor, { type: "get_settings", projectId });
        expect(initial).toMatchObject({
          type: "settings",
          settings: { version: 0, autoRecall: false },
        });
        const input = {
          type: "save_settings" as const,
          projectId,
          expectedVersion: 0,
          settings: {
            ...defaults,
            autoRecall: true,
            projectFolders: ["GCH/Missions"],
            neighborhoodFolders: ["Engineering"],
          },
        };
        expect(
          (yield* service.execute({ scopes: ["orchestration:read"] }, input).pipe(Effect.flip))
            .reason,
        ).toBe("forbidden");
        yield* service.execute(actor, input);
        expect((yield* service.execute(actor, input).pipe(Effect.flip)).reason).toBe("conflict");
        expect(
          (yield* service
            .execute({ scopes: [] }, { type: "get_settings", projectId })
            .pipe(Effect.flip)).reason,
        ).toBe("forbidden");
        expect(
          (yield* service
            .execute(actor, { type: "get_settings", projectId: ProjectId.make("missing") })
            .pipe(Effect.flip)).reason,
        ).toBe("not_found");
        for (const unsafe of ["../outside", "/absolute", ".hidden", "allowed/../outside"]) {
          expect(
            (yield* service
              .execute(actor, {
                ...input,
                expectedVersion: 1,
                settings: { ...defaults, projectFolders: [unsafe] },
              })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid");
        }
      }).pipe(Effect.provide(setup.layer));
      yield* Effect.gen(function* () {
        const service = yield* SynthosContext.SynthosContext;
        expect(yield* service.execute(actor, { type: "get_settings", projectId })).toMatchObject({
          type: "settings",
          settings: {
            version: 1,
            autoRecall: true,
            projectFolders: ["GCH/Missions"],
            neighborhoodFolders: ["Engineering"],
          },
        });
      }).pipe(Effect.provide(setup.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "recalls scoped project and neighborhood notes while excluding other vault material and stale sources",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.writeNote(
        "Project/decision.md",
        "# Obsidian capture\n\nRetain source receipts.",
      );
      yield* setup.writeNote(
        "Neighborhood/lesson.md",
        "# Obsidian capture\n\nUse reviewed lessons.",
      );
      yield* setup.writeNote(
        "Neighborhood/private/secret.md",
        "# Obsidian capture\n\nExcluded material.",
      );
      yield* setup.writeNote(
        "Personal/private.md",
        "# Obsidian capture\n\nUnrelated personal material.",
      );
      yield* setup.fs.symlink(
        setup.path.join(setup.vaultRoot, "Personal"),
        setup.path.join(setup.vaultRoot, "Project", "escape"),
      );
      yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* SynthosContext.SynthosContext;
        yield* service.execute(actor, {
          type: "save_settings",
          projectId,
          expectedVersion: 0,
          settings: {
            ...defaults,
            autoRecall: true,
            projectFolders: ["Project"],
            neighborhoodFolders: ["Neighborhood"],
            excludedPaths: ["Neighborhood/private"],
          },
        });
        const manifest = yield* service.build({
          projectId,
          task: "Obsidian capture",
          role: "crew",
        });
        expect(manifest.routes).toEqual(["memory"]);
        expect(
          manifest.sources
            .filter((source) => source.kind === "obsidian")
            .map((source) => source.path),
        ).toEqual(["Project/decision.md", "Neighborhood/lesson.md"]);
        expect(manifest.neighborhoodUsed).toBe(true);
        yield* service.validate(manifest, setup.repository);
        yield* setup.writeNote(
          "Project/decision.md",
          "# Obsidian capture\n\nUpdated source receipts.",
        );
        expect((yield* service.validate(manifest, setup.repository).pipe(Effect.flip)).reason).toBe(
          "source_changed",
        );
        const refreshed = yield* service.build({
          projectId,
          task: "Obsidian capture",
          role: "crew",
        });
        expect(refreshed.hash).not.toBe(manifest.hash);
        yield* service.execute(actor, {
          type: "save_settings",
          projectId,
          expectedVersion: 1,
          settings: defaults,
        });
        expect(
          (yield* service.validate(refreshed, setup.repository).pipe(Effect.flip)).reason,
        ).toBe("source_changed");
      }).pipe(Effect.provide(setup.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "blocks missing or oversized required notes and preserves explicit pins when recall is disabled",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.writeNote(
        "Pinned/required.md",
        "# Required decision\n\nPreserve this decision regardless of lexical relevance.",
      );
      yield* setup.writeNote("Pinned/large.md", "🚙".repeat(1100));
      yield* Effect.gen(function* () {
        yield* migration;
        const service = yield* SynthosContext.SynthosContext;
        yield* service.execute(actor, {
          type: "save_settings",
          projectId,
          expectedVersion: 0,
          settings: { ...defaults, pinnedNotes: ["Pinned/required.md"] },
        });
        const good = yield* service.build({ projectId, task: "Desktop packaging", role: "lead" });
        expect(good.sources.find((source) => source.kind === "obsidian")).toMatchObject({
          path: "Pinned/required.md",
          required: true,
        });
        expect(good.status).not.toBe("blocked");
        yield* service.execute(actor, {
          type: "save_settings",
          projectId,
          expectedVersion: 1,
          settings: { ...defaults, pinnedNotes: ["Pinned/missing.md"] },
        });
        expect(
          (yield* service.build({ projectId, task: "Desktop packaging", role: "lead" })).status,
        ).toBe("blocked");
        yield* service.execute(actor, {
          type: "save_settings",
          projectId,
          expectedVersion: 2,
          settings: { ...defaults, pinnedNotes: ["Pinned/large.md"] },
        });
        expect(
          (yield* service.build({ projectId, task: "Desktop packaging", role: "lead" })).status,
        ).toBe("blocked");
        expect(
          (yield* service
            .execute(actor, {
              type: "save_settings",
              projectId,
              expectedVersion: 3,
              settings: {
                ...defaults,
                pinnedNotes: ["Pinned/required.md"],
                excludedPaths: ["Pinned"],
              },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid");
      }).pipe(Effect.provide(setup.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "freezes selected graph evidence, rejects changed revisions and blocks missing required selections",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      let graph: SynthosGraphResult = {
        settings: {
          projectId,
          version: 1,
          enabledSources: ["synthome"],
          approvedFolders: [],
          autoRecall: false,
          pinned: ["synthome:one"],
        },
        revision: "revision-one",
        partial: true,
        nodes: [
          {
            id: "synthome:one",
            originalId: "one",
            source: "synthome",
            label: "Graph evidence",
            body: "A cited resource",
            kind: "resource",
            ref: "https://example.com/resource",
            revision: "source-one",
            sensitivity: "public",
            review: "pending",
            provenance: "extracted",
          },
        ],
        edges: [],
      };
      yield* Effect.gen(function* () {
        yield* migration;
        const context = yield* SynthosContext.SynthosContext;
        const selectedGraph = graph;
        graph = { ...graph, settings: { ...graph.settings, pinned: [] } };
        const unselected = yield* context.build({
          projectId,
          task: "Inspect the graph",
          role: "architect",
        });
        expect(unselected.sources.some((source) => source.kind === "graph")).toBe(false);
        yield* context.validate(unselected, setup.repository);
        graph = { ...selectedGraph, revision: "newly-selected-revision" };
        const { graphRevision: _oldGraphRevision, ...legacyManifest } = unselected;
        yield* context.validate(sealManifest(legacyManifest), setup.repository);
        expect(
          (yield* context.validate(unselected, setup.repository).pipe(Effect.flip)).reason,
        ).toBe("source_changed");
        graph = selectedGraph;
        const manifest = yield* context.build({
          projectId,
          task: "Inspect the graph",
          role: "architect",
        });
        expect(manifest.sources.find((s) => s.kind === "graph")).toMatchObject({
          required: true,
          version: "revision-one",
          graph: { nodeId: "synthome:one", sourceRevision: "source-one" },
        });
        yield* context.validate(manifest, setup.repository);
        graph = { ...graph, revision: "revision-two" };
        expect((yield* context.validate(manifest, setup.repository).pipe(Effect.flip)).reason).toBe(
          "source_changed",
        );
        graph = { ...graph, nodes: [] };
        expect(
          (yield* context.build({ projectId, task: "Inspect graph", role: "architect" })).status,
        ).toBe("blocked");
        expect(manifest.sources.find((s) => s.kind === "graph")?.excerpt).toContain(
          "A cited resource",
        );
        graph = {
          ...selectedGraph,
          settings: { ...selectedGraph.settings, pinned: [], autoRecall: true },
          revision: "large-body-revision",
          nodes: [
            {
              ...selectedGraph.nodes[0]!,
              label: "Knowledge provenance",
              body:
                "Relevant knowledge provenance paragraph.\n\n" + "Unrelated material. ".repeat(400),
            },
          ],
        };
        const excerpt = yield* context.build({
          projectId,
          task: "Knowledge provenance",
          role: "architect",
        });
        expect(excerpt.sources.find((source) => source.kind === "graph")?.excerpt).toContain(
          "Relevant knowledge provenance paragraph.",
        );
        expect(excerpt.sources.find((source) => source.kind === "graph")?.excerpt).not.toContain(
          "Unrelated material.",
        );
        expect(excerpt.status).not.toBe("blocked");
      }).pipe(
        Effect.provide(
          setup.layer.pipe(
            Layer.provide(Layer.mock(Graph.SynthosGraph)({ read: () => Effect.sync(() => graph) })),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
