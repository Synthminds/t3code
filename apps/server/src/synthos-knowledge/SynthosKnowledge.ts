import {
  SynthosKnowledgeCommand,
  SynthosKnowledgeEdge,
  SynthosKnowledgeError,
  SynthosKnowledgeNode,
  synthosKnowledgeRequiredScope,
  type AuthEnvironmentScope,
  type SynthosKnowledgeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

interface KnowledgeActor {
  readonly sessionId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}
export class SynthosKnowledge extends Context.Service<
  SynthosKnowledge,
  {
    readonly execute: (
      actor: KnowledgeActor,
      command: SynthosKnowledgeCommand,
    ) => Effect.Effect<SynthosKnowledgeResult, SynthosKnowledgeError>;
  }
>()("t3/synthos-knowledge/SynthosKnowledge") {}

interface Row {
  readonly id: string;
  readonly entity: "node" | "edge";
  readonly version: number;
  readonly deleted: number;
  readonly source_id: string | null;
  readonly target_id: string | null;
  readonly snapshot_json: string;
}
type RecordValue = SynthosKnowledgeNode | SynthosKnowledgeEdge;
const RecordSchema = Schema.Union([SynthosKnowledgeNode, SynthosKnowledgeEdge]);
const decodeNode = Schema.decodeEffect(Schema.fromJsonString(SynthosKnowledgeNode));
const decodeEdge = Schema.decodeEffect(Schema.fromJsonString(SynthosKnowledgeEdge));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(RecordSchema));
const decodeCommand = Schema.decodeEffect(SynthosKnowledgeCommand);
const isKnowledgeError = Schema.is(SynthosKnowledgeError);
const storageError = (cause: unknown) =>
  isKnowledgeError(cause) ? cause : new SynthosKnowledgeError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeRow = (row: Row): Effect.Effect<RecordValue, SynthosKnowledgeError> =>
    row.entity === "node"
      ? decodeNode(row.snapshot_json).pipe(Effect.mapError(storageError))
      : decodeEdge(row.snapshot_json).pipe(Effect.mapError(storageError));
  const load = (id: string) => sql<Row>`SELECT * FROM synthos_knowledge_entities WHERE id = ${id}`;

  const graph = Effect.fn("SynthosKnowledge.graph")(function* (
    command: Extract<SynthosKnowledgeCommand, { type: "graph" }>,
  ) {
    const limit = command.limit ?? 40;
    const edgeLimit = limit * 2;
    let truncated = false;
    let nodes: Row[] = [];
    if (command.focusId !== undefined) {
      const [focus] =
        yield* sql<Row>`SELECT * FROM synthos_knowledge_entities WHERE id = ${command.focusId} AND entity = 'node' AND deleted = 0`;
      if (!focus) return yield* new SynthosKnowledgeError({ reason: "not_found" });
      nodes = [focus];
      let frontier = [focus.id];
      for (let hop = 0; hop < (command.hops ?? 1) && frontier.length > 0; hop += 1) {
        // Each frontier query is capped before expansion, including dense/cyclic graphs.
        const links = yield* sql<Row>`SELECT e.* FROM synthos_knowledge_entities e
          JOIN synthos_knowledge_entities s ON s.id = e.source_id AND s.entity = 'node' AND s.deleted = 0
          JOIN synthos_knowledge_entities t ON t.id = e.target_id AND t.entity = 'node' AND t.deleted = 0
          WHERE e.entity = 'edge' AND e.deleted = 0 AND (${sql.in("e.source_id", frontier)} OR ${sql.in("e.target_id", frontier)})
          ORDER BY e.id LIMIT ${edgeLimit + 1}`;
        if (links.length > edgeLimit) truncated = true;
        const selected = new Set(nodes.map((node) => node.id));
        const candidates = [
          ...new Set(
            links.slice(0, edgeLimit).flatMap((edge) => [edge.source_id!, edge.target_id!]),
          ),
        ].filter((id) => !selected.has(id));
        if (candidates.length === 0) break;
        const remaining = limit - nodes.length;
        const found =
          yield* sql<Row>`SELECT * FROM synthos_knowledge_entities WHERE entity = 'node' AND deleted = 0 AND ${sql.in("id", candidates)} ORDER BY id LIMIT ${remaining + 1}`;
        if (found.length > remaining) truncated = true;
        const added = found.slice(0, remaining);
        nodes.push(...added);
        frontier = added.map((row) => row.id);
      }
    } else {
      const query = command.query?.trim() ?? "";
      const found = yield* sql<Row>`SELECT * FROM synthos_knowledge_entities
        WHERE entity = 'node' AND deleted = 0 AND (${query} = '' OR instr(lower(label), lower(${query})) > 0)
        ORDER BY updated_at DESC, id LIMIT ${limit + 1}`;
      truncated = found.length > limit;
      nodes = found.slice(0, limit);
    }
    const ids = nodes.map((node) => node.id);
    const edgeRows =
      ids.length === 0
        ? []
        : yield* sql<Row>`SELECT * FROM synthos_knowledge_entities
      WHERE entity = 'edge' AND deleted = 0 AND ${sql.in("source_id", ids)} AND ${sql.in("target_id", ids)} ORDER BY id LIMIT ${edgeLimit + 1}`;
    truncated ||= edgeRows.length > edgeLimit;
    return {
      type: "graph" as const,
      nodes: yield* Effect.forEach(nodes, (row) =>
        decodeRow(row).pipe(Effect.map((value) => value as SynthosKnowledgeNode)),
      ),
      edges: yield* Effect.forEach(edgeRows.slice(0, edgeLimit), (row) =>
        decodeRow(row).pipe(Effect.map((value) => value as SynthosKnowledgeEdge)),
      ),
      focusId: command.focusId ?? null,
      truncated,
    };
  });

  const mutate = Effect.fn("SynthosKnowledge.mutate")(function* (
    actor: KnowledgeActor,
    command: Exclude<SynthosKnowledgeCommand, { type: "graph" | "history" }>,
  ) {
    const entity =
      command.type === "delete" ? command.entity : command.type === "node.upsert" ? "node" : "edge";
    const input =
      command.type === "node.upsert"
        ? command.node
        : command.type === "edge.upsert"
          ? command.edge
          : undefined;
    const id = command.type === "delete" ? command.id : input!.id;
    const [previous] = yield* load(id);
    if (previous && previous.entity !== entity)
      return yield* new SynthosKnowledgeError({ reason: "conflict" });
    if ((previous?.version ?? null) !== command.expectedVersion)
      return yield* new SynthosKnowledgeError({ reason: "conflict" });
    if (command.type === "delete" && !previous)
      return yield* new SynthosKnowledgeError({ reason: "not_found" });
    const correctionReason =
      command.type === "delete"
        ? command.reason.trim()
        : (command.correctionReason?.trim() ?? null);
    if ((previous || correctionReason !== null) && !correctionReason)
      return yield* new SynthosKnowledgeError({ reason: "invalid" });
    if (
      input &&
      (!input.rationale.trim() ||
        input.sourceRefs.some((ref) => !ref.ref.trim()) ||
        ("label" in input && !input.label.trim()))
    ) {
      return yield* new SynthosKnowledgeError({ reason: "invalid" });
    }
    if (command.type === "edge.upsert") {
      const endpoints = [...new Set([command.edge.sourceId, command.edge.targetId])];
      const found =
        yield* sql<Row>`SELECT * FROM synthos_knowledge_entities WHERE entity = 'node' AND deleted = 0 AND ${sql.in("id", endpoints)}`;
      if (found.length !== endpoints.length)
        return yield* new SynthosKnowledgeError({ reason: "missing_endpoint" });
    }
    const old = previous ? yield* decodeRow(previous) : undefined;
    const now = DateTime.formatIso(yield* DateTime.now);
    const record = {
      ...(input ?? old!),
      ownerId: "environment" as const,
      version: (old?.version ?? 0) + 1,
      supersedesVersion: old?.version ?? null,
      correctionReason,
      deleted: command.type === "delete",
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      createdBy: old?.createdBy ?? actor.sessionId,
      updatedBy: actor.sessionId,
    } satisfies RecordValue;
    const json = yield* encodeRecord(record);
    const label = "label" in record ? record.label : record.kind;
    const source = "sourceId" in record ? record.sourceId : null;
    const target = "targetId" in record ? record.targetId : null;
    if (previous) {
      const changed = yield* sql<{
        id: string;
      }>`UPDATE synthos_knowledge_entities SET version = ${record.version}, deleted = ${record.deleted ? 1 : 0}, label = ${label}, source_id = ${source}, target_id = ${target}, updated_at = ${now}, snapshot_json = ${json}
        WHERE id = ${id} AND version = ${previous.version} RETURNING id`;
      if (changed.length !== 1) return yield* new SynthosKnowledgeError({ reason: "conflict" });
    } else {
      yield* sql`INSERT INTO synthos_knowledge_entities (id,entity,version,deleted,label,source_id,target_id,updated_at,snapshot_json)
        VALUES (${id},${entity},${record.version},0,${label},${source},${target},${now},${json})`;
    }
    yield* sql`INSERT INTO synthos_knowledge_revisions (id,version,entity,snapshot_json) VALUES (${id},${record.version},${entity},${json})`;
    return entity === "node"
      ? { type: "node" as const, node: record as SynthosKnowledgeNode }
      : { type: "edge" as const, edge: record as SynthosKnowledgeEdge };
  });

  const execute = Effect.fn("SynthosKnowledge.execute")(function* (
    actor: KnowledgeActor,
    input: SynthosKnowledgeCommand,
  ): Effect.fn.Return<SynthosKnowledgeResult, SynthosKnowledgeError> {
    const command = yield* decodeCommand(input).pipe(
      Effect.mapError((cause) => new SynthosKnowledgeError({ reason: "invalid", cause })),
    );
    if (!actor.scopes.includes(synthosKnowledgeRequiredScope(command)))
      return yield* new SynthosKnowledgeError({ reason: "forbidden" });
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (command.type === "graph") return yield* graph(command);
          if (command.type === "history") {
            const [current] = yield* load(command.id);
            if (!current || current.entity !== command.entity)
              return yield* new SynthosKnowledgeError({ reason: "not_found" });
            const limit = command.limit ?? 20;
            const rows =
              yield* sql<Row>`SELECT * FROM synthos_knowledge_revisions WHERE id = ${command.id} AND entity = ${command.entity} ORDER BY version DESC LIMIT ${limit + 1}`;
            return {
              type: "history" as const,
              entity: command.entity,
              id: command.id,
              revisions: yield* Effect.forEach(rows.slice(0, limit), decodeRow),
              truncated: rows.length > limit,
            };
          }
          return yield* mutate(actor, command);
        }),
      )
      .pipe(Effect.mapError(storageError));
  });
  return SynthosKnowledge.of({ execute });
});

export const layer = Layer.effect(SynthosKnowledge, make);
