import * as Schema from "effect/Schema";
import type { AuthEnvironmentScope } from "./auth.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/));
const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Kind = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/));
const Version = Schema.Int.check(Schema.isGreaterThan(0));

// These defaults are UI vocabulary; bounded kind strings permit extensions without a new build.
export const SYNTHOS_KNOWLEDGE_NODE_TYPES = [
  "knowledge",
  "note",
  "core",
  "domain",
  "pack",
  "agent",
  "human",
  "engine",
  "tool",
  "skill",
  "schedule",
  "session",
  "decision",
  "artifact",
] as const;
export const SYNTHOS_KNOWLEDGE_EDGE_KINDS = [
  "mentions",
  "about",
  "part_of",
  "authored_by",
  "attended_by",
  "follows_up",
  "derived_from",
  "references",
  "relates_to",
  "same_as",
  "owns",
  "runs",
  "uses",
  "produces",
  "escalates_to",
  "scheduled_by",
  "routed_to",
  "decided_by",
] as const;

export const SynthosKnowledgeSourceRef = Schema.Struct({
  kind: Schema.Literals([
    "manual",
    "thread",
    "workflow",
    "file",
    "url",
    "mem",
    "obsidian",
    "device",
  ]),
  ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  label: Schema.optionalKey(ShortText),
  version: Schema.optionalKey(ShortText),
  sensitivity: Schema.Literals(["public", "private", "local_only"]),
});
export type SynthosKnowledgeSourceRef = typeof SynthosKnowledgeSourceRef.Type;

const Provenance = {
  provenance: Schema.Literals(["manual", "extracted", "inferred"]),
  rationale: ShortText,
  sourceRefs: Schema.Array(SynthosKnowledgeSourceRef).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
};
export const SynthosKnowledgeNodeInput = Schema.Struct({
  id: Id,
  nodeType: Kind,
  label: ShortText,
  body: Schema.String.check(Schema.isMaxLength(12_000)),
  layer: Schema.Literals(["artifact", "decision", "reasoning", "workaround"]),
  ...Provenance,
});
export type SynthosKnowledgeNodeInput = typeof SynthosKnowledgeNodeInput.Type;
export const SynthosKnowledgeEdgeInput = Schema.Struct({
  id: Id,
  sourceId: Id,
  targetId: Id,
  kind: Kind,
  weight: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ...Provenance,
});
export type SynthosKnowledgeEdgeInput = typeof SynthosKnowledgeEdgeInput.Type;

const Revision = {
  ownerId: Schema.Literal("environment"),
  version: Version,
  supersedesVersion: Schema.NullOr(Version),
  correctionReason: Schema.NullOr(ShortText),
  deleted: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: Schema.String,
  updatedBy: Schema.String,
};
export const SynthosKnowledgeNode = Schema.Struct({
  ...SynthosKnowledgeNodeInput.fields,
  ...Revision,
});
export type SynthosKnowledgeNode = typeof SynthosKnowledgeNode.Type;
export const SynthosKnowledgeEdge = Schema.Struct({
  ...SynthosKnowledgeEdgeInput.fields,
  ...Revision,
});
export type SynthosKnowledgeEdge = typeof SynthosKnowledgeEdge.Type;

export const SynthosKnowledgeCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("graph"),
    focusId: Schema.optionalKey(Id),
    hops: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 80 }))),
    query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  }),
  Schema.Struct({
    type: Schema.Literal("history"),
    entity: Schema.Literals(["node", "edge"]),
    id: Id,
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("node.upsert"),
    node: SynthosKnowledgeNodeInput,
    expectedVersion: Schema.NullOr(Version),
    correctionReason: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("edge.upsert"),
    edge: SynthosKnowledgeEdgeInput,
    expectedVersion: Schema.NullOr(Version),
    correctionReason: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    entity: Schema.Literals(["node", "edge"]),
    id: Id,
    expectedVersion: Version,
    reason: ShortText,
  }),
]);
export type SynthosKnowledgeCommand = typeof SynthosKnowledgeCommand.Type;

export const SynthosKnowledgeResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("graph"),
    nodes: Schema.Array(SynthosKnowledgeNode),
    edges: Schema.Array(SynthosKnowledgeEdge),
    focusId: Schema.NullOr(Id),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("node"), node: SynthosKnowledgeNode }),
  Schema.Struct({ type: Schema.Literal("edge"), edge: SynthosKnowledgeEdge }),
  Schema.Struct({
    type: Schema.Literal("history"),
    entity: Schema.Literals(["node", "edge"]),
    id: Id,
    revisions: Schema.Array(Schema.Union([SynthosKnowledgeNode, SynthosKnowledgeEdge])),
    truncated: Schema.Boolean,
  }),
]);
export type SynthosKnowledgeResult = typeof SynthosKnowledgeResult.Type;

export function synthosKnowledgeRequiredScope(
  command: SynthosKnowledgeCommand,
): AuthEnvironmentScope {
  return command.type === "graph" || command.type === "history"
    ? "orchestration:read"
    : "orchestration:operate";
}

export class SynthosKnowledgeError extends Schema.TaggedError<SynthosKnowledgeError>()(
  "SynthosKnowledgeError",
  {
    reason: Schema.Literals([
      "forbidden",
      "invalid",
      "not_found",
      "conflict",
      "missing_endpoint",
      "storage",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Knowledge graph operation failed: ${this.reason}.`;
  }
}
