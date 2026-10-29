import { SynthosGraphHistory } from "@t3tools/contracts";
import { exploreWithEngine } from "./synthmind.ts";
import { importBrain } from "./synthbrain.ts";
import {
  SynthosGraphCommand,
  SynthosGraphError,
  SynthosGraphSettings,
  SynthosGraphSnapshot,
  SynthosGraphEdge,
  synthosGraphRequiredScope,
  type AuthEnvironmentScope,
  type ProjectId,
  type SynthosGraphResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projects from "../project/ProjectService.ts";
import { scopedGraph, exploreGraph, validateSnapshot } from "./graph.ts";
import { refreshSynthome } from "./synthome.ts";
const Store = Schema.Struct({
  settings: SynthosGraphSettings,
  snapshots: Schema.Array(SynthosGraphSnapshot),
  alignments: Schema.Array(SynthosGraphEdge),
  history: Schema.optionalKey(SynthosGraphHistory),
  missionSelections: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});
const missionSelection = (store: typeof Store.Type, id: string) =>
  store.missionSelections && Object.hasOwn(store.missionSelections, id)
    ? store.missionSelections[id]!
    : [];
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Store));
const encode = Schema.encodeSync(Schema.fromJsonString(Store));
const decodeCommand = Schema.decodeEffect(SynthosGraphCommand, { onExcessProperty: "error" });
const isGraphError = Schema.is(SynthosGraphError);
const failure = (cause: unknown) =>
  isGraphError(cause) ? cause : new SynthosGraphError({ reason: "storage", cause });
export class SynthosGraph extends Context.Service<
  SynthosGraph,
  {
    readonly execute: (
      actor: { readonly scopes: readonly AuthEnvironmentScope[]; readonly sessionId?: string },
      command: SynthosGraphCommand,
    ) => Effect.Effect<SynthosGraphResult, SynthosGraphError>;
    readonly read: (
      projectId: ProjectId,
      workflowId?: string,
    ) => Effect.Effect<SynthosGraphResult, SynthosGraphError>;
  }
>()("t3/synthos-graph/SynthosGraph") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* Projects.ProjectService;
  const load = Effect.fn("SynthosGraph.load")(function* (projectId: ProjectId) {
    if (Option.isNone(yield* projects.getById(projectId)))
      return yield* new SynthosGraphError({ reason: "not_found" });
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM synthos_graph WHERE project_id = ${projectId}`;
    return rows[0]
      ? decode(rows[0].snapshot_json)
      : ({
          settings: {
            projectId,
            version: 0,
            enabledSources: [],
            approvedFolders: [],
            autoRecall: false,
            pinned: [],
          },
          snapshots: [],
          alignments: [],
        } as typeof Store.Type);
  });
  const read = Effect.fn("SynthosGraph.read")(function* (
    projectId: ProjectId,
    workflowId?: string,
  ) {
    const store = yield* load(projectId);
    return {
      settings: {
        ...store.settings,
        pinned: [
          ...new Set([
            ...store.settings.pinned,
            ...(workflowId ? missionSelection(store, workflowId) : []),
          ]),
        ],
      },
      ...scopedGraph(store.snapshots, store.alignments, store.settings),
    };
  }, Effect.mapError(failure));
  const execute = Effect.fn("SynthosGraph.execute")(function* (
    actor: { readonly scopes: readonly AuthEnvironmentScope[]; readonly sessionId?: string },
    input: SynthosGraphCommand,
  ) {
    const command = yield* decodeCommand(input).pipe(
      Effect.mapError((cause) => new SynthosGraphError({ reason: "invalid", cause })),
    );
    if (!actor.scopes.includes(synthosGraphRequiredScope(command)))
      return yield* new SynthosGraphError({ reason: "forbidden" });
    const projectId = command.type === "configure" ? command.settings.projectId : command.projectId;
    const store = yield* load(projectId);
    const current = {
      settings: store.settings,
      ...scopedGraph(store.snapshots, store.alignments, store.settings),
    };
    if (command.type === "history")
      return { ...current, nodes: [], edges: [], history: store.history ?? [] };
    if (command.type === "settings") return { ...current, nodes: [], edges: [] };
    if (command.type === "explore")
      return {
        ...(yield* exploreWithEngine(current, command)),
        settings: store.settings,
        selection: command.workflowId ? missionSelection(store, command.workflowId) : [],
      };
    const expected =
      command.type === "configure" ? command.settings.version : command.expectedVersion;
    if (expected !== store.settings.version)
      return yield* new SynthosGraphError({ reason: "conflict" });
    let next = store;
    if (command.type === "unalign") {
      if (!store.alignments.some((edge) => edge.id === command.id))
        return yield* new SynthosGraphError({ reason: "not_found" });
      next = { ...store, alignments: store.alignments.filter((edge) => edge.id !== command.id) };
    } else if (command.type === "configure") {
      if (
        command.settings.approvedFolders.some(
          (f) =>
            f.startsWith("/") ||
            /[\\\x00-\x1f:]/.test(f) ||
            f.split("/").some((p) => !p || p.startsWith(".") || p.trim() !== p),
        )
      )
        return yield* new SynthosGraphError({ reason: "invalid" });
      next = { ...store, settings: command.settings };
    } else if (
      command.type === "import" ||
      command.type === "refresh" ||
      command.type === "import_brain"
    ) {
      if (command.type === "refresh" && !store.settings.enabledSources.includes("synthome"))
        return yield* new SynthosGraphError({ reason: "forbidden" });
      const snapshot =
        command.type === "import_brain"
          ? importBrain(command.data, store.settings)
          : command.type === "import"
            ? command.snapshot
            : yield* refreshSynthome(command.query, command.focusId);
      if (!store.settings.enabledSources.includes(snapshot.source))
        return yield* new SynthosGraphError({ reason: "forbidden" });
      yield* Effect.try(() => validateSnapshot(snapshot)).pipe(
        Effect.mapError((cause) => new SynthosGraphError({ reason: "invalid", cause })),
      );
      if (
        snapshot.source === "synthbrain" &&
        snapshot.nodes.some(
          (n) =>
            !store.settings.approvedFolders.some((f) => n.ref === f || n.ref.startsWith(`${f}/`)),
        )
      )
        return yield* new SynthosGraphError({ reason: "forbidden" });
      next = {
        ...store,
        snapshots: [...store.snapshots.filter((s) => s.source !== snapshot.source), snapshot],
      };
    } else if (command.type === "select") {
      if (command.ids.some((id) => !current.nodes.some((n) => n.id === id)))
        return yield* new SynthosGraphError({ reason: "not_found" });
      next = command.workflowId
        ? {
            ...store,
            missionSelections: {
              ...store.missionSelections,
              [command.workflowId]: [...new Set(command.ids)],
            },
          }
        : { ...store, settings: { ...store.settings, pinned: [...new Set(command.ids)] } };
    } else {
      const edge = command.edge;
      if (
        !edge.reviewed ||
        edge.provenance !== "manual" ||
        !edge.rationale.trim() ||
        !["same_as", "relates_to", "supersedes"].includes(edge.predicate) ||
        !current.nodes.some((n) => n.id === edge.source) ||
        !current.nodes.some((n) => n.id === edge.target) ||
        edge.source === edge.target ||
        current.edges.some((e) => e.id === edge.id)
      )
        return yield* new SynthosGraphError({ reason: "invalid" });
      next = { ...store, alignments: [...store.alignments, edge] };
    }
    next = { ...next, settings: { ...next.settings, version: expected + 1 } };
    next = {
      ...next,
      history: [
        ...(store.history ?? []),
        {
          version: expected + 1,
          revision: scopedGraph(next.snapshots, next.alignments, next.settings).revision,
          operation: command.type,
          actor: actor.sessionId ?? "local",
        },
      ].slice(-50),
    };
    const json = encode(next);
    const changed =
      expected === 0
        ? yield* sql`INSERT INTO synthos_graph(project_id,version,snapshot_json) VALUES (${projectId},1,${json}) ON CONFLICT(project_id) DO NOTHING RETURNING project_id`
        : yield* sql`UPDATE synthos_graph SET version = ${expected + 1}, snapshot_json = ${json} WHERE project_id = ${projectId} AND version = ${expected} RETURNING project_id`;
    if (changed.length !== 1) return yield* new SynthosGraphError({ reason: "conflict" });
    return {
      settings: next.settings,
      selection:
        command.type === "select" && command.workflowId
          ? missionSelection(next, command.workflowId)
          : [],
      ...exploreGraph(scopedGraph(next.snapshots, next.alignments, next.settings), {
        type: "explore",
        projectId,
      }),
    };
  }, Effect.mapError(failure));
  return SynthosGraph.of({ execute, read });
});
export const layer = Layer.effect(SynthosGraph, make);
