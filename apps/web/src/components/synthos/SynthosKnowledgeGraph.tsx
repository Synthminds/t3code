/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  Plus,
  RefreshCw,
  Save,
  Search,
  History,
  ArrowRight,
  Trash2,
  Undo2,
} from "lucide-react";
import { SYNTHOS_KNOWLEDGE_NODE_TYPES, SYNTHOS_KNOWLEDGE_EDGE_KINDS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  SynthosKnowledgeNode,
  SynthosKnowledgeEdge,
  SynthosKnowledgeCommand,
  SynthosKnowledgeResult,
} from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { synthosRequest } from "./synthosRequest";

type Graph = Extract<SynthosKnowledgeResult, { type: "graph" }>;
type HistoryResult = Extract<SynthosKnowledgeResult, { type: "history" }>;
type Entity = SynthosKnowledgeNode | SynthosKnowledgeEdge;
type Layer = SynthosKnowledgeNode["layer"];
type Provenance = SynthosKnowledgeNode["provenance"];
type SourceRef = SynthosKnowledgeNode["sourceRefs"][number];
const layers: readonly Layer[] = ["artifact", "decision", "reasoning", "workaround"];
const provenanceOptions: readonly Provenance[] = ["manual", "extracted", "inferred"];
const sourceKinds: readonly SourceRef["kind"][] = [
  "manual",
  "thread",
  "workflow",
  "file",
  "url",
  "mem",
  "obsidian",
  "device",
];
const blankGraph: Graph = { type: "graph", nodes: [], edges: [], focusId: null, truncated: false };

export function SynthosKnowledgeGraph({ environmentId }: { environmentId: EnvironmentId | null }) {
  const [graph, setGraph] = useState<Graph>(blankGraph);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingNode, setEditingNode] = useState<SynthosKnowledgeNode | "new" | null>(null);
  const [editingEdge, setEditingEdge] = useState<SynthosKnowledgeEdge | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [removed, setRemoved] = useState<Entity | null>(null);
  const pending = useRef(false);
  const historyRequest = useRef(0);
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes[0];
  const relations = selected
    ? graph.edges.filter((edge) => edge.sourceId === selected.id || edge.targetId === selected.id)
    : [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load the host's durable graph snapshot and ignore results after the query or host changes
  useEffect(() => {
    if (!environmentId) return;
    const controller = new AbortController();
    historyRequest.current++;
    void synthosRequest<SynthosKnowledgeResult>(environmentId, "/api/synthos/knowledge", {
      method: "POST",
      body: {
        type: "graph",
        ...(focusId ? { focusId, hops: 2 } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
        limit: 24,
      },
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted && result.type === "graph") {
          setGraph(result);
          setError(null);
          if (requestKey > 0) setHistory(null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [environmentId, focusId, requestKey, query]);

  async function run(command: SynthosKnowledgeCommand) {
    if (!environmentId) throw new Error("Connect an environment to use the knowledge graph.");
    return synthosRequest<SynthosKnowledgeResult>(environmentId, "/api/synthos/knowledge", {
      method: "POST",
      body: command,
    });
  }
  async function mutate(command: SynthosKnowledgeCommand) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await run(command);
      if (result.type === "node") {
        setSelectedId(result.node.id);
        if (result.node.deleted) setRemoved(result.node);
      }
      if (result.type === "edge" && result.edge.deleted) setRemoved(result.edge);
      setEditingNode(null);
      setEditingEdge(null);
      setRequestKey((value) => value + 1);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function showHistory(entity: "node" | "edge", id: string) {
    const requestId = ++historyRequest.current;
    setError(null);
    try {
      const result = await run({ type: "history", entity, id, limit: 20 });
      if (result.type === "history" && requestId === historyRequest.current) setHistory(result);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function undo() {
    if (!removed) return;
    const restored =
      "nodeType" in removed
        ? await mutate({
            type: "node.upsert",
            node: nodeInput(removed),
            expectedVersion: removed.version,
            correctionReason: "Restore the removed node.",
          })
        : await mutate({
            type: "edge.upsert",
            edge: edgeInput(removed),
            expectedVersion: removed.version,
            correctionReason: "Restore the removed relationship.",
          });
    if (restored) setRemoved(null);
  }

  return (
    <div className="sx-kg">
      <section className="sx-panel">
        <header className="sx-panel-title">
          <GitBranch size={17} />
          <h3>Semantic knowledge graph</h3>
          <span>
            {graph.nodes.length} NODES / {graph.edges.length} RELATIONS
          </span>
        </header>
        <form
          className="sx-graph-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setLoading(true);
            setFocusId(null);
            setQuery(queryInput.trim());
            setRequestKey((value) => value + 1);
          }}
        >
          <label className="sx-field">
            <span className="sr-only">Search graph</span>
            <span className="sx-search-box">
              <Search size={14} />
              <input
                value={queryInput}
                maxLength={256}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder="Find a node by label…"
              />
            </span>
          </label>
          <button
            type="submit"
            className="sx-icon-button"
            aria-label="Search knowledge graph"
            disabled={!environmentId || busy}
          >
            <Search size={15} />
          </button>
          <button
            type="button"
            className="sx-button"
            disabled={!environmentId || busy}
            onClick={() => {
              setEditingEdge(null);
              setEditingNode("new");
            }}
          >
            <Plus size={14} />
            Add node
          </button>
          <button
            type="button"
            className="sx-icon-button"
            aria-label="Refresh knowledge graph"
            disabled={!environmentId || busy}
            onClick={() => {
              setLoading(true);
              setRequestKey((value) => value + 1);
            }}
          >
            <RefreshCw size={15} />
          </button>
        </form>
        {focusId && (
          <div className="sx-graph-focus">
            <span>Two-hop neighborhood</span>
            <button type="button" onClick={() => setFocusId(null)}>
              Show all nodes
            </button>
          </div>
        )}
        {graph.nodes.length > 0 ? (
          <GraphCanvas
            graph={graph}
            selectedId={selected?.id ?? null}
            onSelect={(id) => {
              historyRequest.current++;
              setSelectedId(id);
              setEditingNode(null);
              setEditingEdge(null);
              setHistory(null);
            }}
          />
        ) : (
          <div className="sx-graph-empty">
            <GitBranch size={36} strokeWidth={1} />
            <h4>
              {loading && environmentId ? "Loading your graph…" : "A place for connected knowledge"}
            </h4>
            <p>
              {environmentId
                ? "Add a note, entity, or evidence node. Connect it with a sourced or explicitly inferred relationship."
                : "Connect an environment to read and build its shared knowledge graph."}
            </p>
          </div>
        )}
        <div className="sx-graph-legend">
          <span>
            <i />
            Sourced / manual
          </span>
          <span>
            <i />
            Inferred
          </span>
          <span>Shared within this environment</span>
        </div>
        {graph.truncated && (
          <p className="sx-panel-note">
            Showing a bounded result. Search or focus a node to explore more of the graph.
          </p>
        )}
        <div className="sx-node-list" aria-label="Knowledge graph nodes">
          {graph.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              aria-pressed={selected?.id === node.id}
              onClick={() => {
                historyRequest.current++;
                setSelectedId(node.id);
                setEditingNode(null);
                setEditingEdge(null);
                setHistory(null);
              }}
            >
              <strong>{node.label}</strong>
              <span>
                {node.nodeType} · {node.layer} · v{node.version}
              </span>
            </button>
          ))}
        </div>
      </section>
      {error && (
        <p className="sx-error" role="alert">
          {error}
        </p>
      )}
      {removed && (
        <div className="sx-notice">
          <span>Removed from the active graph. Revision history is retained.</span>
          <button type="button" className="sx-button" disabled={busy} onClick={() => void undo()}>
            <Undo2 size={14} />
            Undo removal
          </button>
        </div>
      )}
      <div className="sx-split">
        {editingNode ? (
          <NodeEditor
            key={editingNode === "new" ? "new" : `${editingNode.id}:${editingNode.version}`}
            node={editingNode === "new" ? null : editingNode}
            busy={busy}
            onSave={mutate}
            onCancel={() => setEditingNode(null)}
          />
        ) : (
          <section className="sx-panel">
            <header className="sx-panel-title">
              <GitBranch size={16} />
              <h3>Knowledge record</h3>
              <span>{selected ? `VERSION ${selected.version}` : "SELECT A NODE"}</span>
            </header>
            {selected ? (
              <div className="sx-form">
                <div className="sx-record-heading">
                  <h3>{selected.label}</h3>
                  <span className="sx-state">
                    {selected.nodeType} / {selected.layer}
                  </span>
                </div>
                <p className="sx-graph-body">{selected.body || "No body recorded."}</p>
                <ProvenanceDetails entity={selected} />
                <div className="sx-actions">
                  <button
                    type="button"
                    className="sx-button"
                    onClick={() => {
                      setEditingNode(selected);
                      setEditingEdge(null);
                    }}
                  >
                    Correct record
                  </button>
                  <button
                    type="button"
                    className="sx-button"
                    onClick={() => {
                      setQuery("");
                      setQueryInput("");
                      setFocusId(selected.id);
                    }}
                  >
                    Explore neighborhood
                  </button>
                  <button
                    type="button"
                    className="sx-button"
                    onClick={() => void showHistory("node", selected.id)}
                  >
                    <History size={13} />
                    History
                  </button>
                </div>
                <RemoveControl
                  key={selected.id}
                  entity="node"
                  record={selected}
                  busy={busy}
                  onRemove={mutate}
                />
              </div>
            ) : (
              <p className="sx-empty">
                Select a node to inspect its sources, reasoning, and version history.
              </p>
            )}
          </section>
        )}
        {editingEdge ? (
          <EdgeEditor
            key={
              editingEdge === "new"
                ? `new:${selected?.id}`
                : `${editingEdge.id}:${editingEdge.version}`
            }
            edge={editingEdge === "new" ? null : editingEdge}
            sourceId={selected?.id ?? ""}
            nodes={graph.nodes}
            busy={busy}
            onSave={mutate}
            onCancel={() => setEditingEdge(null)}
          />
        ) : (
          <section className="sx-panel">
            <header className="sx-panel-title">
              <GitBranch size={16} />
              <h3>Relationships</h3>
              <span>{relations.length}</span>
            </header>
            {relations.map((edge) => (
              <div className="sx-relation" key={edge.id}>
                <div>
                  <strong>
                    {graph.nodes.find((node) => node.id === edge.sourceId)?.label ?? edge.sourceId}
                  </strong>
                  <ArrowRight size={13} />
                  <strong>
                    {graph.nodes.find((node) => node.id === edge.targetId)?.label ?? edge.targetId}
                  </strong>
                </div>
                <span className="sx-state">
                  {edge.kind} · {edge.provenance} · v{edge.version}
                </span>
                <p>{edge.rationale}</p>
                <div className="sx-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingEdge(edge);
                      setEditingNode(null);
                    }}
                  >
                    Inspect / correct
                  </button>
                  <button type="button" onClick={() => void showHistory("edge", edge.id)}>
                    History
                  </button>
                </div>
              </div>
            ))}
            {relations.length === 0 && (
              <p className="sx-empty">No relationships are recorded for this node.</p>
            )}
            <div className="sx-form">
              <button
                type="button"
                className="sx-button"
                disabled={!selected || graph.nodes.length < 2 || busy}
                onClick={() => {
                  setEditingEdge("new");
                  setEditingNode(null);
                }}
              >
                <Plus size={14} />
                Connect an existing node
              </button>
              <p className="sx-muted">
                Relationships are explicit. Mark an inference and explain its rationale; inferred
                links are never presented as sourced facts.
              </p>
            </div>
          </section>
        )}
      </div>
      {history && (
        <section className="sx-panel sx-history">
          <header className="sx-panel-title">
            <History size={16} />
            <h3>Revision history</h3>
            <span>{history.entity}</span>
          </header>
          {history.revisions.map((revision) => (
            <div className="sx-receipt" key={revision.version}>
              <div>
                <strong>
                  Version {revision.version}
                  {revision.deleted ? " · removed" : ""}
                </strong>
                <span className="sx-muted">{revision.updatedAt}</span>
              </div>
              <p>{revision.correctionReason || "Original record"}</p>
              <pre>{"body" in revision ? revision.body : revision.rationale}</pre>
              <ProvenanceDetails entity={revision} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function GraphCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const positions = new Map<string, { x: number; y: number }>();
  let rows = 1;
  for (const [column, layer] of layers.entries()) {
    const nodes = graph.nodes.filter((node) => node.layer === layer);
    rows = Math.max(rows, nodes.length);
    nodes.forEach((node, index) =>
      positions.set(node.id, { x: 101 + column * 185, y: 88 + index * 68 }),
    );
  }
  const height = Math.max(280, rows * 68 + 65);
  return (
    <div className="sx-graph-canvas">
      <svg
        viewBox={`0 0 760 ${height}`}
        role="group"
        aria-label="Knowledge nodes arranged by layer. Select a node or use the node list below."
        style={{ height, minWidth: 650 }}
      >
        <defs>
          <marker
            id="sx-kg-arrow"
            markerWidth="5"
            markerHeight="5"
            refX="4"
            refY="2.5"
            orient="auto"
          >
            <path d="M0 0 L5 2.5 L0 5" fill="var(--sx-muted)" />
          </marker>
        </defs>
        {layers.map((layer, index) => (
          <text
            key={layer}
            x={101 + index * 185}
            y={29}
            textAnchor="middle"
            className="sx-graph-layer"
          >
            {layer.toUpperCase()}
          </text>
        ))}
        {graph.edges.map((edge) => {
          const a = positions.get(edge.sourceId),
            b = positions.get(edge.targetId);
          if (!a || !b) return null;
          const highlighted = edge.sourceId === selectedId || edge.targetId === selectedId;
          const direction = Math.sign(b.x - a.x) || 1;
          const startX = a.x + 70 * direction;
          const endX = b.x + (a.x === b.x ? 73 : -73 * direction);
          const firstControl = startX + 55 * direction;
          const secondControl = a.x === b.x ? endX + 55 : endX - 55 * direction;
          return (
            <g key={edge.id} aria-hidden="true" opacity={highlighted ? 1 : 0.3}>
              <path
                d={`M${startX} ${a.y} C${firstControl} ${a.y},${secondControl} ${b.y},${endX} ${b.y}`}
                fill="none"
                stroke={edge.provenance === "inferred" ? "#ff4db8" : "#00ead7"}
                strokeWidth={highlighted ? 1.7 : 1}
                strokeDasharray={edge.provenance === "inferred" ? "4 4" : undefined}
                markerEnd="url(#sx-kg-arrow)"
              />
              {highlighted && (
                <text
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 7}
                  className="sx-graph-edge-label"
                  textAnchor="middle"
                >
                  {edge.kind}
                </text>
              )}
            </g>
          );
        })}
        {graph.nodes.map((node) => {
          const point = positions.get(node.id)!;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.label}, ${node.nodeType}, ${node.provenance}, version ${node.version}`}
              aria-pressed={selectedId === node.id}
              className="sx-graph-node"
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
              transform={`translate(${point.x - 70},${point.y - 20})`}
            >
              <rect
                width={140}
                height={40}
                fill={selectedId === node.id ? "#1e3a4a" : "#13213d"}
                stroke={selectedId === node.id ? "#b9d6ee" : "#4c6482"}
              />
              <text x={10} y={17} className="sx-graph-node-label">
                {node.label.length > 20 ? `${node.label.slice(0, 18)}…` : node.label}
              </text>
              <text x={10} y={31} className="sx-graph-node-type">
                {node.nodeType.slice(0, 14)} · {node.provenance}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ProvenanceDetails({ entity }: { entity: Entity }) {
  return (
    <div className="sx-provenance">
      <span className={`sx-state ${entity.provenance === "inferred" ? "is-inferred" : ""}`}>
        {entity.provenance === "inferred"
          ? "Inference, not verified source"
          : entity.provenance === "extracted"
            ? "Extracted from sources"
            : "Manually recorded"}
      </span>
      {entity.rationale && <p>{entity.rationale}</p>}
      <ul>
        {entity.sourceRefs.map((source) => (
          <li key={`${source.kind}:${source.ref}:${source.version ?? ""}:${source.sensitivity}`}>
            <strong>{source.label || source.kind}</strong>
            <code>{source.ref}</code>
            <small>
              {source.sensitivity.replaceAll("_", " ")}
              {source.version ? ` · version ${source.version}` : ""}
            </small>
          </li>
        ))}
      </ul>
      <small>Record ID: {entity.id}</small>
      <small>
        Updated {entity.updatedAt} · {entity.updatedBy}
      </small>
    </div>
  );
}

function useProvenance(existing: Entity | null) {
  const [provenance, setProvenance] = useState<Provenance>(existing?.provenance ?? "manual");
  const [rationale, setRationale] = useState(existing?.rationale ?? "");
  const [kind, setKind] = useState<SourceRef["kind"]>("manual");
  const [ref, setRef] = useState("");
  const [version, setVersion] = useState("");
  const [sensitivity, setSensitivity] = useState<SourceRef["sensitivity"]>("local_only");
  const [correctionReason, setCorrectionReason] = useState("");
  const [retainedSources, setRetainedSources] = useState<readonly SourceRef[]>(
    existing?.sourceRefs ?? [],
  );
  const sources: readonly SourceRef[] = [
    ...retainedSources,
    ...(ref.trim()
      ? [
          {
            kind,
            ref: ref.trim(),
            ...(version.trim() ? { version: version.trim() } : {}),
            sensitivity,
          },
        ]
      : []),
  ];
  const valid =
    Boolean(rationale.trim()) &&
    sources.length > 0 &&
    sources.length <= 16 &&
    (!existing || Boolean(correctionReason.trim()));
  const fields = (
    <>
      <label className="sx-field">
        Provenance
        <select
          value={provenance}
          onChange={(event) => setProvenance(event.target.value as Provenance)}
        >
          {provenanceOptions.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      <label className="sx-field">
        Rationale
        <textarea
          rows={2}
          maxLength={512}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          required
          placeholder="What supports this record or inference?"
        />
      </label>
      {retainedSources.length > 0 && (
        <div className="sx-provenance">
          <ul>
            {retainedSources.map((source, index) => (
              <li
                key={`${source.kind}:${source.ref}:${source.version ?? ""}:${source.sensitivity}`}
              >
                <strong>{source.kind}</strong>
                <code>{source.ref}</code>
                <button
                  type="button"
                  className="sx-remove-button"
                  onClick={() =>
                    setRetainedSources((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  Remove source from this revision
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="sx-binding-grid">
        <label className="sx-field">
          Add source type
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as SourceRef["kind"])}
          >
            {sourceKinds.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="sx-field">
          Sensitivity
          <select
            value={sensitivity}
            onChange={(event) => setSensitivity(event.target.value as SourceRef["sensitivity"])}
          >
            <option value="local_only">Local only</option>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </label>
      </div>
      <label className="sx-field">
        Source reference
        <span>Every record needs a reference, including manual captures.</span>
        <input
          value={ref}
          maxLength={2048}
          onChange={(event) => setRef(event.target.value)}
          placeholder="Thread ID, file path, URL, or note ID"
        />
      </label>
      <label className="sx-field">
        Source version <span>Optional hash or version</span>
        <input value={version} onChange={(event) => setVersion(event.target.value)} />
      </label>
      {existing && (
        <label className="sx-field">
          Correction reason
          <textarea
            rows={2}
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
            required
            placeholder="Explain this revision."
          />
        </label>
      )}
    </>
  );
  return { provenance, rationale, sourceRefs: sources, correctionReason, valid, fields };
}

function NodeEditor({
  node,
  busy,
  onSave,
  onCancel,
}: {
  node: SynthosKnowledgeNode | null;
  busy: boolean;
  onSave: (command: SynthosKnowledgeCommand) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [id] = useState(() => node?.id ?? randomUUID());
  const [label, setLabel] = useState(node?.label ?? "");
  const [nodeType, setNodeType] = useState(node?.nodeType ?? "note");
  const [layer, setLayer] = useState<Layer>(node?.layer ?? "artifact");
  const [body, setBody] = useState(node?.body ?? "");
  const provenance = useProvenance(node);
  return (
    <section className="sx-panel">
      <header className="sx-panel-title">
        <Plus size={16} />
        <h3>{node ? "Correct knowledge record" : "Add knowledge record"}</h3>
        <span>{node ? `FROM VERSION ${node.version}` : "NEW"}</span>
      </header>
      <form
        className="sx-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            type: "node.upsert",
            node: {
              id,
              label: label.trim(),
              nodeType: nodeType.trim(),
              layer,
              body,
              provenance: provenance.provenance,
              rationale: provenance.rationale,
              sourceRefs: provenance.sourceRefs,
            },
            expectedVersion: node?.version ?? null,
            ...(node ? { correctionReason: provenance.correctionReason } : {}),
          });
        }}
      >
        <label className="sx-field">
          Label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
            maxLength={180}
          />
        </label>
        <div className="sx-binding-grid">
          <label className="sx-field">
            Node type
            <input
              value={nodeType}
              list="sx-node-types"
              maxLength={64}
              pattern="[a-z][a-z0-9_]{0,63}"
              onChange={(event) => setNodeType(event.target.value)}
              required
              placeholder="note, entity, evidence…"
            />
            <datalist id="sx-node-types">
              {SYNTHOS_KNOWLEDGE_NODE_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>
          <label className="sx-field">
            Layer
            <select value={layer} onChange={(event) => setLayer(event.target.value as Layer)}>
              {layers.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="sx-field">
          Content
          <textarea
            rows={5}
            maxLength={12000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {provenance.fields}
        <div className="sx-actions">
          <button
            type="submit"
            className="sx-button sx-button-primary"
            disabled={busy || !label.trim() || !nodeType.trim() || !provenance.valid}
          >
            <Save size={14} />
            {busy ? "Saving…" : "Save record"}
          </button>
          <button type="button" className="sx-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function EdgeEditor({
  edge,
  sourceId,
  nodes,
  busy,
  onSave,
  onCancel,
}: {
  edge: SynthosKnowledgeEdge | null;
  sourceId: string;
  nodes: readonly SynthosKnowledgeNode[];
  busy: boolean;
  onSave: (command: SynthosKnowledgeCommand) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [id] = useState(() => edge?.id ?? randomUUID());
  const from = edge?.sourceId ?? sourceId;
  const [targetId, setTargetId] = useState(edge?.targetId ?? "");
  const [kind, setKind] = useState(edge?.kind ?? "relates_to");
  const [weight, setWeight] = useState(edge?.weight ?? 1);
  const provenance = useProvenance(edge);
  return (
    <section className="sx-panel">
      <header className="sx-panel-title">
        <GitBranch size={16} />
        <h3>{edge ? "Correct relationship" : "Connect knowledge"}</h3>
      </header>
      <form
        className="sx-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            type: "edge.upsert",
            edge: {
              id,
              sourceId: from,
              targetId,
              kind: kind.trim(),
              weight,
              provenance: provenance.provenance,
              rationale: provenance.rationale,
              sourceRefs: provenance.sourceRefs,
            },
            expectedVersion: edge?.version ?? null,
            ...(edge ? { correctionReason: provenance.correctionReason } : {}),
          });
        }}
      >
        <p className="sx-muted">From: {nodes.find((node) => node.id === from)?.label ?? from}</p>
        <label className="sx-field">
          To
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)} required>
            <option value="">Choose an existing node</option>
            {nodes
              .filter((node) => node.id !== from)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
          </select>
        </label>
        <div className="sx-binding-grid">
          <label className="sx-field">
            Relationship type
            <input
              value={kind}
              list="sx-edge-types"
              maxLength={64}
              pattern="[a-z][a-z0-9_]{0,63}"
              onChange={(event) => setKind(event.target.value)}
              required
            />
            <datalist id="sx-edge-types">
              {SYNTHOS_KNOWLEDGE_EDGE_KINDS.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>
          <label className="sx-field">
            Weight (0 to 1)
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={weight}
              onChange={(event) => setWeight(Number(event.target.value))}
            />
          </label>
        </div>
        {provenance.fields}
        <div className="sx-actions">
          <button
            type="submit"
            className="sx-button sx-button-primary"
            disabled={busy || !targetId || !kind.trim() || !provenance.valid}
          >
            <Save size={14} />
            Save relationship
          </button>
          <button type="button" className="sx-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
        {edge && <RemoveControl entity="edge" record={edge} busy={busy} onRemove={onSave} />}
      </form>
    </section>
  );
}

function RemoveControl({
  entity,
  record,
  busy,
  onRemove,
}: {
  entity: "node" | "edge";
  record: Entity;
  busy: boolean;
  onRemove: (command: SynthosKnowledgeCommand) => Promise<unknown>;
}) {
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState("");
  return opened ? (
    <div className="sx-remove-confirm">
      <label className="sx-field">
        Reason for removal
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Explain why this record should be removed."
        />
      </label>
      <p className="sx-muted">
        This removes the {entity} from the active graph and retains its revision history.
      </p>
      <div className="sx-actions">
        <button
          type="button"
          className="sx-button sx-button-danger"
          disabled={busy || !reason.trim()}
          onClick={() =>
            void onRemove({
              type: "delete",
              entity,
              id: record.id,
              expectedVersion: record.version,
              reason: reason.trim(),
            })
          }
        >
          Confirm removal
        </button>
        <button
          type="button"
          className="sx-button"
          onClick={() => setOpened(false)}
          disabled={busy}
        >
          Keep record
        </button>
      </div>
    </div>
  ) : (
    <button
      type="button"
      className="sx-remove-button"
      onClick={() => setOpened(true)}
      disabled={busy}
    >
      <Trash2 size={12} />
      Remove {entity}
    </button>
  );
}
function nodeInput(node: SynthosKnowledgeNode) {
  return {
    id: node.id,
    nodeType: node.nodeType,
    label: node.label,
    body: node.body,
    layer: node.layer,
    provenance: node.provenance,
    rationale: node.rationale,
    sourceRefs: node.sourceRefs,
  };
}
function edgeInput(edge: SynthosKnowledgeEdge) {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    kind: edge.kind,
    provenance: edge.provenance,
    rationale: edge.rationale,
    weight: edge.weight,
    sourceRefs: edge.sourceRefs,
  };
}
function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The graph request failed. Reload the latest record before retrying a correction.";
}
