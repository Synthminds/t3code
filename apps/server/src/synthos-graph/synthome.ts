import { SynthosGraphError, SynthosGraphSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { digest } from "../synthos-context/manifest.ts";
const Node = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  type: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  review_status: Schema.optionalKey(Schema.String),
});
const Edge = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  target: Schema.String,
  relation: Schema.String,
  review_status: Schema.optionalKey(Schema.String),
});
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      structuredContent: Schema.Unknown,
    }),
  }),
);
const decodeNeighborhood = Schema.decodeUnknownEffect(
  Schema.Struct({ nodes: Schema.Array(Node), edges: Schema.Array(Edge) }),
);
const decodeSearch = Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Array(Node) }));
const decodeRevision = Schema.decodeUnknownEffect(
  Schema.Struct({ analysis: Schema.Struct({ sourceRevision: Schema.String }) }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(SynthosGraphSnapshot);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const call = Effect.fn("SynthosGraph.synthomeCall")(function* (
  name: string,
  args: Record<string, unknown>,
) {
  const fetch = yield* FetchHttpClient.Fetch;
  const text = yield* Effect.tryPromise(async (signal) => {
    const response = await fetch("https://synthome.app/mcp", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: encode({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { ...args, response_format: "json" } },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("synthome_unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 2_000_000) throw new Error("synthome_response_limit");
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  });
  const value = yield* decodeJson(
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n")
      : text,
  );
  const envelope = yield* decodeEnvelope(value);
  if (envelope.result.isError) return yield* new SynthosGraphError({ reason: "unavailable" });
  return envelope.result.structuredContent;
});
export const refreshSynthome = Effect.fn("SynthosGraph.refreshSynthome")(
  function* (query: string, focusId?: string) {
    const before = yield* call("synthome_get_network_stats", {}).pipe(
      Effect.flatMap(decodeRevision),
    );
    const data = focusId
      ? yield* call("synthome_explore_connections", {
          start_node_id: focusId.replace(/^synthome:/, ""),
          max_depth: 2,
          max_nodes: 80,
        }).pipe(Effect.flatMap(decodeNeighborhood))
      : {
          nodes: (yield* call("synthome_search_nodes", { query, limit: 50 }).pipe(
            Effect.flatMap(decodeSearch),
          )).items,
          edges: [],
        };
    const after = yield* call("synthome_get_network_stats", {}).pipe(
      Effect.flatMap(decodeRevision),
    );
    if (before.analysis.sourceRevision !== after.analysis.sourceRevision)
      return yield* new SynthosGraphError({ reason: "conflict" });
    const revision = digest(encode({ sourceRevision: before.analysis.sourceRevision, data }));
    return yield* decodeSnapshot({
      source: "synthome",
      revision,
      partial: true,
      nodes: data.nodes.map((n) => ({
        id: `synthome:${n.id}`,
        originalId: n.id,
        source: "synthome",
        label: n.title,
        body: n.summary ?? "",
        kind: n.type,
        ref: n.url || `https://synthome.app/#${encodeURIComponent(n.id)}`,
        revision: before.analysis.sourceRevision,
        sensitivity: "public",
        review: n.review_status ?? "unreviewed",
        provenance: "extracted",
      })),
      edges: data.edges.map((e) => ({
        id: `synthome:${e.id}`,
        source: `synthome:${e.source}`,
        target: `synthome:${e.target}`,
        predicate: e.relation,
        provenance: "extracted",
        rationale: "Public Synthome classification; not proof of causation or identity",
        reviewed: e.review_status === "reviewed",
      })),
    });
  },
  Effect.mapError((cause) => new SynthosGraphError({ reason: "unavailable", cause })),
);
