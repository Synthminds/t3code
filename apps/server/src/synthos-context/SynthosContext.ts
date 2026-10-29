import * as Graph from "../synthos-graph/SynthosGraph.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git resolves a local repository identity without shell interpolation.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import {
  SynthosContextCommand,
  SynthosContextError,
  SynthosContextSettings,
  synthosContextRequiredScope,
  type AuthEnvironmentScope,
  type ProjectId,
  type SynthosContextManifest,
  type SynthosContextResult,
  type SynthosContextSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectService from "../project/ProjectService.ts";
import * as Vault from "../synthos-connections/ObsidianVault.ts";
import * as ConnectionsConfig from "../synthos-connections/ConnectionsConfig.ts";
import { parseRouting, selectRoutes, selectMemories, type MemoryNote } from "./retrieval.ts";
import { sealManifest, digest } from "./manifest.ts";

interface BuildInput {
  readonly projectId: ProjectId;
  readonly task: string;
  readonly workflowId?: string;
  readonly role: string;
  readonly workspaceRoot?: string;
}
interface Actor {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}
export class SynthosContext extends Context.Service<
  SynthosContext,
  {
    readonly execute: (
      actor: Actor,
      command: SynthosContextCommand,
    ) => Effect.Effect<SynthosContextResult, SynthosContextError>;
    readonly build: (
      input: BuildInput,
    ) => Effect.Effect<SynthosContextManifest, SynthosContextError>;
    readonly validate: (
      manifest: SynthosContextManifest,
      workspaceRoot: string,
      baseRef?: string,
    ) => Effect.Effect<void, SynthosContextError>;
  }
>()("t3/synthos-context/SynthosContext") {}
const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(SynthosContextSettings));
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
const validPath = (path: string) =>
  path.length > 0 &&
  path.length <= 1024 &&
  !/[\\\x00-\x1f:]/.test(path) &&
  path
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && part.trim() === part && !/[. ]$/.test(part),
    );
const isContextError = Schema.is(SynthosContextError);
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(SynthosContextSettings));
const decodeCommand = Schema.decodeEffect(SynthosContextCommand, { onExcessProperty: "error" });
const wrapError = (cause: unknown) =>
  isContextError(cause) ? cause : new SynthosContextError({ reason: "storage", cause });
const runGit = NodeUtil.promisify(NodeChildProcess.execFile);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const vault = yield* Vault.ObsidianVault;
  const graph = yield* Effect.serviceOption(Graph.SynthosGraph);
  const getProject = Effect.fn("SynthosContext.project")(function* (id: ProjectId) {
    const project = yield* projects.getById(id).pipe(Effect.mapError(wrapError));
    if (Option.isNone(project)) return yield* new SynthosContextError({ reason: "not_found" });
    return project.value;
  });
  const settings = Effect.fn("SynthosContext.settings")(function* (projectId: ProjectId) {
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM synthos_context_settings WHERE project_id = ${projectId}`;
    return rows[0]
      ? decodeSettings(rows[0].snapshot_json)
      : ({
          projectId,
          version: 0,
          autoRecall: false,
          approvedNotes: [],
          projectFolders: [],
          neighborhoodFolders: [],
          pinnedNotes: [],
          excludedPaths: [],
        } satisfies SynthosContextSettings);
  });
  const build = Effect.fn("SynthosContext.build")(function* (input: BuildInput) {
    const project = yield* getProject(input.projectId);
    const root = input.workspaceRoot ?? project.workspaceRoot;
    const configuration = yield* settings(input.projectId);
    const sources: SynthosContextSource[] = [];
    const omissions: Array<{ path: string; reason: string }> = [];
    let blocked = false;
    let graphRevision: string | null = null;
    const repoRead = (path: string) =>
      Vault.ObsidianVault.pipe(
        Effect.flatMap((reader) => reader.read({ path })),
        Effect.provide(Vault.layer({ vaultRoot: root })),
      );
    const routing = yield* repoRead("ROUTING.md").pipe(Effect.option);
    let routeIds: string[] = [];
    if (Option.isSome(routing)) {
      sources.push({
        kind: "repository",
        path: "ROUTING.md",
        version: routing.value.version,
        tier: 0,
        reason: "Repository routing source",
        excerpt: "",
        required: true,
      });
      const parsed = yield* Effect.try(() => parseRouting(routing.value.content)).pipe(
        Effect.option,
      );
      if (Option.isNone(parsed)) {
        omissions.push({ path: "ROUTING.md", reason: "Invalid structured routing" });
        blocked = true;
      } else {
        const routes = selectRoutes(parsed.value, input.task, input.role);
        routeIds = routes.map((route) => route.id);
        sources[0] = {
          ...sources[0]!,
          excerpt: encodeUnknown({
            routes,
            guidance:
              "Skip is an initial optimization; inspect dependencies when evidence crosses a boundary.",
          }),
        };
        let remaining = 3072;
        for (const path of new Set(["CONTEXT.md", ...routes.flatMap((route) => route.load)])) {
          if (!validPath(path) || !path.endsWith(".md")) {
            omissions.push({
              path,
              reason: "Only safe repository Markdown sources can be supplied",
            });
            continue;
          }
          const note = yield* repoRead(path).pipe(Effect.option);
          if (Option.isNone(note)) {
            omissions.push({
              path,
              reason: "Repository guidance unavailable; inspect source before relying on it",
            });
            continue;
          }
          const bytes = Buffer.byteLength(note.value.content);
          if (bytes > remaining) {
            omissions.push({
              path,
              reason: "Repository excerpt budget; retrieve source when needed",
            });
            continue;
          }
          remaining -= bytes;
          sources.push({
            kind: "repository",
            path,
            version: note.value.version,
            tier: 0,
            reason: `Routes: ${routeIds.join(", ")}`,
            excerpt: note.value.content,
            required: false,
          });
        }
      }
    } else
      omissions.push({
        path: "ROUTING.md",
        reason: "No repository routing available; normal repository exploration remains available",
      });
    const notes: MemoryNote[] = [];
    const excluded = (path: string) =>
      configuration.excludedPaths.some((folder) => within(path, folder));
    const seenPaths = new Set<string>();
    const readNotes = Effect.fn("SynthosContext.readNotes")(function* (
      paths: readonly string[],
      tier: 1 | 2,
    ) {
      for (const path of paths) {
        if (seenPaths.has(path) || excluded(path)) continue;
        seenPaths.add(path);
        const required = configuration.pinnedNotes.includes(path);
        if (notes.length >= 300 && !required) {
          omissions.push({ path, reason: "Memory candidate limit" });
          continue;
        }
        const note = yield* vault.read({ path }).pipe(Effect.option);
        if (Option.isNone(note)) {
          omissions.push({ path, reason: "Memory source unavailable" });
          if (required) blocked = true;
          continue;
        }
        notes.push({ ...note.value, tier });
      }
    });
    const scanFolders = Effect.fn("SynthosContext.scanFolders")(function* (
      folders: readonly string[],
      tier: 1 | 2,
    ) {
      for (const folder of folders) {
        const listing = yield* vault.list({ folders: [folder], limit: 100 }).pipe(Effect.option);
        if (Option.isNone(listing)) {
          omissions.push({ path: folder, reason: "Memory neighborhood unavailable" });
          continue;
        }
        if (listing.value.truncated)
          omissions.push({
            path: folder,
            reason: "Memory scan reached bounded coverage; narrow the neighborhood",
          });
        yield* readNotes(
          listing.value.notes.map((note) => note.path),
          tier,
        );
      }
    });
    yield* readNotes(configuration.pinnedNotes, 1);
    let neighborhoodUsed = false;
    if (configuration.autoRecall) {
      yield* readNotes(configuration.approvedNotes, 1);
      yield* scanFolders(configuration.projectFolders, 1);
      const first = selectMemories(notes, input.task, input.role);
      if (first.neighborhoodUsed && configuration.neighborhoodFolders.length > 0) {
        neighborhoodUsed = true;
        yield* scanFolders(configuration.neighborhoodFolders, 2);
      }
    }
    const pinned = notes.filter((note) => configuration.pinnedNotes.includes(note.path));
    let memoryBytes = 0;
    for (const note of pinned) {
      memoryBytes += Buffer.byteLength(note.content);
      if (memoryBytes > 4096 || pinned.length > 5) {
        blocked = true;
        omissions.push({ path: note.path, reason: "Required memory exceeds packet memory budget" });
        continue;
      }
      sources.push({
        kind: "obsidian",
        path: note.path,
        version: note.version,
        tier: 1,
        reason: "Explicitly pinned required note",
        excerpt: note.content,
        required: true,
      });
    }
    const selected = selectMemories(
      notes.filter((note) => !configuration.pinnedNotes.includes(note.path)),
      input.task,
      input.role,
    );
    let memoryCount = pinned.length;
    for (const note of selected.selected) {
      const size = Buffer.byteLength(note.excerpt);
      if (memoryBytes + size > 4096 || memoryCount >= 5) {
        omissions.push({
          path: note.path,
          reason: "Memory budget reserved for higher-priority sources",
        });
        continue;
      }
      memoryCount++;
      memoryBytes += size;
      sources.push({
        kind: "obsidian",
        path: note.path,
        version: note.version,
        tier: note.tier,
        reason: note.reason,
        excerpt: note.excerpt,
        required: false,
      });
    }
    omissions.push(...selected.omitted);
    if (Option.isSome(graph)) {
      const result = yield* graph.value.read(input.projectId, input.workflowId).pipe(Effect.option);
      if (Option.isNone(result)) {
        omissions.push({ path: "graph", reason: "Graph service unavailable" });
        blocked = true;
      } else {
        const snapshot = result.value;
        graphRevision = snapshot.revision;
        const pinnedIds = new Set(snapshot.settings.pinned);
        for (const id of pinnedIds)
          if (!snapshot.nodes.some((n) => n.id === id)) {
            blocked = true;
            omissions.push({
              path: id,
              reason: "Required graph source unavailable or outside approved scope",
            });
          }
        const candidates = selectMemories(
          snapshot.nodes.map((n) => ({
            path: n.id,
            content: `# ${n.label}\n${n.body}`,
            version: n.revision,
            tier: 2 as const,
          })),
          input.task,
          input.role,
        );
        const chosen = [
          ...snapshot.nodes.filter((n) => pinnedIds.has(n.id)),
          ...(snapshot.settings.autoRecall && memoryCount < 3
            ? candidates.selected
                .map((n) => snapshot.nodes.find((node) => node.id === n.path)!)
                .filter((n) => !pinnedIds.has(n.id))
            : []),
        ];
        for (const node of chosen) {
          const required = pinnedIds.has(node.id);
          const edges = snapshot.edges
            .filter((e) => e.source === node.id || e.target === node.id)
            .slice(0, 12);
          const excerpt = encodeUnknown({
            label: node.label,
            body: required
              ? node.body
              : (candidates.selected.find((candidate) => candidate.path === node.id)?.excerpt ??
                ""),
            review: node.review,
            ref: node.ref,
            relations: edges,
          });
          const size = Buffer.byteLength(excerpt);
          if (required) {
            while (memoryCount >= 5 || memoryBytes + size > 4096) {
              const index = sources.findLastIndex(
                (source) => source.kind === "obsidian" && !source.required,
              );
              if (index < 0) break;
              const [removed] = sources.splice(index, 1);
              memoryCount--;
              memoryBytes -= Buffer.byteLength(removed!.excerpt);
              omissions.push({
                path: removed!.path,
                reason: "Memory budget reserved for explicit graph selection",
              });
            }
          }
          if (memoryCount >= 5 || memoryBytes + size > 4096) {
            omissions.push({ path: node.id, reason: "Shared memory budget exceeded" });
            if (required) blocked = true;
            continue;
          }
          memoryCount++;
          memoryBytes += size;
          sources.push({
            kind: "graph",
            path: node.id,
            version: snapshot.revision,
            tier: 2,
            reason: required
              ? "Explicitly selected graph evidence"
              : "Relevant project-scoped graph evidence",
            excerpt,
            required,
            graph: {
              nodeId: node.id,
              originalId: node.originalId,
              source: node.source,
              sourceRevision: node.revision,
              edgeIds: edges.map((e) => e.id),
              provenance: node.provenance,
              review: node.review,
              ref: node.ref,
            },
          });
        }
        if (chosen.length && snapshot.partial)
          omissions.push({
            path: "graph",
            reason: "Partial graph snapshot; absence of a relationship is not evidence of absence",
          });
      }
    }
    const revision = yield* Effect.tryPromise(() =>
      runGit("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 }),
    ).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.orElseSucceed(() => null),
    );
    return sealManifest({
      version: 1,
      projectId: input.projectId,
      settingsVersion: configuration.version,
      graphRevision,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      role: input.role,
      repositoryRevision: revision,
      routes: routeIds,
      sources,
      omissions: omissions.slice(0, 100),
      status: blocked ? "blocked" : omissions.length ? "degraded" : "ready",
      neighborhoodUsed,
      query: input.task,
    });
  }, Effect.mapError(wrapError));
  const validate = Effect.fn("SynthosContext.validate")(function* (
    manifest: SynthosContextManifest,
    workspaceRoot: string,
    baseRef?: string,
  ) {
    const configuration = yield* settings(manifest.projectId);
    if (configuration.version !== manifest.settingsVersion)
      return yield* new SynthosContextError({ reason: "source_changed" });
    const revision = yield* Effect.tryPromise(() =>
      runGit("git", ["rev-parse", baseRef ?? "HEAD"], { cwd: workspaceRoot, timeout: 5000 }),
    ).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.orElseSucceed(() => null),
    );
    if (revision !== manifest.repositoryRevision)
      return yield* new SynthosContextError({ reason: "source_changed" });
    const currentGraph =
      manifest.graphRevision !== undefined ||
      manifest.sources.some((source) => source.kind === "graph")
        ? Option.isSome(graph)
          ? yield* graph.value.read(manifest.projectId, manifest.workflowId).pipe(Effect.option)
          : Option.none()
        : Option.none();
    if (
      manifest.graphRevision !== undefined &&
      (manifest.graphRevision === null
        ? Option.isSome(graph)
        : Option.isNone(currentGraph) || currentGraph.value.revision !== manifest.graphRevision)
    )
      return yield* new SynthosContextError({ reason: "source_changed" });
    for (const source of manifest.sources) {
      if (source.kind === "graph") {
        if (
          Option.isNone(currentGraph) ||
          currentGraph.value.revision !== source.version ||
          !currentGraph.value.nodes.some((n) => n.id === source.path)
        )
          return yield* new SynthosContextError({ reason: "source_changed" });
        continue;
      }
      if (baseRef && source.kind === "repository") {
        const committed = yield* Effect.tryPromise(() =>
          runGit("git", ["show", `${revision}:${source.path}`], {
            cwd: workspaceRoot,
            timeout: 5000,
            maxBuffer: 256000,
          }),
        ).pipe(Effect.option);
        if (Option.isNone(committed) || digest(committed.value.stdout) !== source.version)
          return yield* new SynthosContextError({ reason: "source_changed" });
      }
      const operation =
        source.kind === "obsidian"
          ? vault.read({ path: source.path })
          : Vault.ObsidianVault.pipe(
              Effect.flatMap((reader) => reader.read({ path: source.path })),
              Effect.provide(Vault.layer({ vaultRoot: workspaceRoot })),
            );
      const current = yield* operation.pipe(Effect.option);
      if (Option.isNone(current) || current.value.version !== source.version)
        return yield* new SynthosContextError({ reason: "source_changed" });
    }
  }, Effect.mapError(wrapError));
  const execute = Effect.fn("SynthosContext.execute")(function* (
    actor: Actor,
    input: SynthosContextCommand,
  ) {
    const command = yield* decodeCommand(input).pipe(
      Effect.mapError(() => new SynthosContextError({ reason: "invalid" })),
    );
    if (!actor.scopes.includes(synthosContextRequiredScope(command)))
      return yield* new SynthosContextError({ reason: "forbidden" });
    yield* getProject(command.projectId);
    if (command.type === "preview")
      return { type: "preview" as const, manifest: yield* build(command) };
    if (command.type === "get_settings")
      return { type: "settings" as const, settings: yield* settings(command.projectId) };
    const paths = [
      ...command.settings.approvedNotes,
      ...command.settings.projectFolders,
      ...command.settings.neighborhoodFolders,
      ...command.settings.pinnedNotes,
      ...command.settings.excludedPaths,
    ];
    if (
      paths.some((path) => !validPath(path)) ||
      [...command.settings.approvedNotes, ...command.settings.pinnedNotes].some(
        (path) => !path.endsWith(".md"),
      ) ||
      command.settings.pinnedNotes.some((path) =>
        command.settings.excludedPaths.some((folder) => within(path, folder)),
      )
    )
      return yield* new SynthosContextError({ reason: "invalid" });
    const next = {
      ...command.settings,
      projectId: command.projectId,
      version: command.expectedVersion + 1,
    };
    const json = encodeSettings(next);
    const rows =
      command.expectedVersion === 0
        ? yield* sql`INSERT INTO synthos_context_settings(project_id,version,snapshot_json) VALUES (${command.projectId},1,${json}) ON CONFLICT(project_id) DO NOTHING RETURNING project_id`
        : yield* sql`UPDATE synthos_context_settings SET version = ${next.version}, snapshot_json = ${json} WHERE project_id = ${command.projectId} AND version = ${command.expectedVersion} RETURNING project_id`;
    if (rows.length !== 1) return yield* new SynthosContextError({ reason: "conflict" });
    return { type: "settings" as const, settings: next };
  }, Effect.mapError(wrapError));
  return SynthosContext.of({ execute, build, validate });
});
export const layer = Layer.effect(SynthosContext, make);
export const layerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConnectionsConfig.ConnectionsConfig;
    return layer.pipe(
      Layer.provide(
        Vault.layer(config.obsidianVaultRoot ? { vaultRoot: config.obsidianVaultRoot } : {}),
      ),
    );
  }),
).pipe(Layer.provide(ConnectionsConfig.layer));
