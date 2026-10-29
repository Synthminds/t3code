/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useState } from "react";
import { SynthosBrainExport } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type {
  EnvironmentId,
  ProjectId,
  SynthosGraphCommand,
  SynthosGraphResult,
} from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { synthosRequest } from "./synthosRequest";

const decodeBrain = Schema.decodeUnknownSync(Schema.fromJsonString(SynthosBrainExport));
export function SynthosGraphExplorer({
  environmentId,
  activeWorkflow,
}: {
  environmentId: EnvironmentId | null;
  activeWorkflow?: { id: string; projectId: ProjectId } | undefined;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [projectId, setProjectId] = useState(activeWorkflow?.projectId ?? "");
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  return (
    <section className="sx-panel">
      <header className="sx-panel-title">
        <h3>NEURAL HIGHWAY // GRAPH EXPLORER</h3>
      </header>
      <label className="sx-field">
        Project
        <select value={project?.id ?? ""} onChange={(e) => setProjectId(e.target.value)}>
          <option value="" disabled>
            Select a project
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      {project && environmentId ? (
        <Explorer
          key={`${environmentId}:${project.id}`}
          environmentId={environmentId}
          projectId={project.id}
          workflowId={activeWorkflow?.projectId === project.id ? activeWorkflow.id : undefined}
        />
      ) : (
        <p className="sx-empty">
          Connect a host and create a project to explore its approved knowledge.
        </p>
      )}
    </section>
  );
}
function Explorer({
  environmentId,
  projectId,
  workflowId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workflowId?: string | undefined;
}) {
  const [graph, setGraph] = useState<SynthosGraphResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [rationale, setRationale] = useState("");
  const [predicate, setPredicate] = useState("relates_to");
  const [direction, setDirection] = useState<"incoming" | "outgoing" | "both">("both");
  const [dimension, setDimension] = useState<2 | 3>(2);
  const [angle, setAngle] = useState(0);
  const [folders, setFolders] = useState("");
  const [notice, setNotice] = useState("");
  const node = graph?.nodes.find((n) => n.id === selected);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch the selected host/project snapshot; abort on unmount to prevent cross-project results.
  useEffect(() => {
    const controller = new AbortController();
    void synthosRequest<SynthosGraphResult>(environmentId, "/api/synthos/graph", {
      method: "POST",
      body: { type: "explore", projectId, ...(workflowId ? { workflowId } : {}) },
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setGraph(result);
          setFolders(result.settings.approvedFolders.join("\n"));
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Graph unavailable");
      });
    return () => controller.abort();
  }, [environmentId, projectId, workflowId]);
  async function run(command: SynthosGraphCommand) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await synthosRequest<SynthosGraphResult>(environmentId, "/api/synthos/graph", {
        method: "POST",
        body: command.type === "explore" && workflowId ? { ...command, workflowId } : command,
      });
      setGraph(result);
      if (command.type === "select")
        setNotice(
          "Selection saved for future attempts. Open Context Deck to preview the exact packet.",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Graph request failed");
    } finally {
      setBusy(false);
    }
  }
  const points = new Map(
    (graph?.nodes ?? []).map((n, i, all) => {
      const theta = i * Math.PI * (3 - Math.sqrt(5)) + angle;
      const y = 1 - (2 * (i + 0.5)) / all.length;
      const radius = Math.sqrt(1 - y * y);
      const z = dimension === 3 ? Math.cos(theta) * radius : 0;
      return [
        n.id,
        {
          x: 400 + (Math.sin(theta) * radius * 310) / (1 - z * 0.25),
          y: 240 + (y * 185) / (1 - z * 0.25),
          z,
        },
      ];
    }),
  );
  return (
    <div className="sx-form">
      {error && (
        <p role="alert" className="sx-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        className="sx-button"
        disabled={busy}
        onClick={() => void run({ type: "history", projectId })}
      >
        Revision receipts
      </button>
      {graph?.history && (
        <ol>
          {graph.history.map((entry) => (
            <li key={entry.version}>
              v{entry.version} · {entry.operation} · {entry.revision.slice(0, 16)} · {entry.actor}
            </li>
          ))}
        </ol>
      )}
      <div className="sx-actions">
        <input
          aria-label="Search graph"
          value={query}
          maxLength={300}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the neural highway"
        />
        <button
          className="sx-button"
          disabled={busy}
          onClick={() => void run({ type: "explore", projectId, query })}
        >
          Search snapshot
        </button>
        <button
          className="sx-button"
          disabled={busy || !graph?.settings.enabledSources.includes("synthome")}
          onClick={() =>
            graph &&
            void run({
              type: "refresh",
              projectId,
              expectedVersion: graph.settings.version,
              query,
              ...(node?.source === "synthome" ? { focusId: node.id } : {}),
            })
          }
        >
          {busy ? "Uplink active…" : "Refresh Synthome"}
        </button>
        <button
          className="sx-button"
          aria-pressed={dimension === 3}
          onClick={() => setDimension((d) => (d === 2 ? 3 : 2))}
        >
          {dimension === 2 ? "Enter 3D" : "Return to 2D"}
        </button>
      </div>
      {dimension === 3 && (
        <label className="sx-field">
          Orbit · motion stays paused until you move this control
          <input
            type="range"
            min={0}
            max={6.28}
            step={0.02}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
          />
        </label>
      )}
      <div className="sx-neural-map" aria-busy={busy}>
        <svg
          viewBox="0 0 800 480"
          role="group"
          aria-label={`${dimension}D project knowledge graph; use the node list below to select evidence`}
        >
          <defs>
            <pattern id="sx-neural-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke="var(--sx-neural-cyan)"
                strokeOpacity=".12"
              />
            </pattern>
          </defs>
          <rect width="800" height="480" fill="url(#sx-neural-grid)" />
          {graph?.edges.map((e) => {
            const a = points.get(e.source);
            const b = points.get(e.target);
            return a && b ? (
              <line
                key={e.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={e.provenance === "inferred" ? "#db8cee" : "#31d9eb"}
                strokeOpacity=".4"
                strokeDasharray={e.provenance === "inferred" ? "4 4" : undefined}
              />
            ) : null;
          })}
          {graph?.nodes.map((n) => {
            const p = points.get(n.id)!;
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`Select ${n.label}`}
                onClick={() => setSelected(n.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(n.id);
                  }
                }}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={(selected === n.id ? 10 : 6) * (1 + p.z * 0.3)}
                  fill={n.source === "synthome" ? "#32e6ee" : "#ff50bd"}
                />
                <text x={p.x + 12} y={p.y + 4} fill="var(--sx-neural-text)" fontSize="10">
                  {n.label.slice(0, 26)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="sx-muted">
        {graph?.nodes.length ?? 0} nodes · {graph?.edges.length ?? 0} relationships ·{" "}
        {graph?.partial ? "PARTIAL SNAPSHOT" : "Loaded snapshot"}. Similarity is not fact;
        centrality is not credibility.
      </p>
      <div className="sx-knowledge-grid">
        <div className="sx-neural-list" aria-label="Graph nodes">
          {graph?.nodes.map((n) => (
            <button
              className="sx-note-item"
              key={n.id}
              aria-pressed={selected === n.id}
              onClick={() => setSelected(n.id)}
            >
              <strong>{n.label}</strong>
              <span>
                {n.source} · {n.kind} · {n.review}
              </span>
            </button>
          ))}
        </div>
        <div>
          {node ? (
            <>
              <h3>{node.label}</h3>
              {workflowId && graph && (
                <div className="sx-actions">
                  <button
                    className="sx-button"
                    disabled={busy || (graph.selection?.length ?? 0) >= 5}
                    onClick={() =>
                      void run({
                        type: "select",
                        projectId,
                        workflowId,
                        expectedVersion: graph.settings.version,
                        ids: [...new Set([...(graph.selection ?? []), node.id])],
                      })
                    }
                  >
                    Add selection to active mission
                  </button>
                  <button
                    className="sx-button"
                    disabled={busy || !graph.selection?.length}
                    onClick={() =>
                      void run({
                        type: "select",
                        projectId,
                        workflowId,
                        expectedVersion: graph.settings.version,
                        ids: [],
                      })
                    }
                  >
                    Clear mission selection
                  </button>
                </div>
              )}
              <p>{node.body}</p>
              <p className="sx-muted">
                {node.sensitivity} · {node.provenance} · {node.review}
              </p>
              <code>{node.ref}</code>
              <p className="sx-muted">Source revision: {node.revision}</p>
              <div className="sx-actions">
                <select
                  aria-label="Traversal direction"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as typeof direction)}
                >
                  <option value="both">Both directions</option>
                  <option value="incoming">Incoming</option>
                  <option value="outgoing">Outgoing</option>
                </select>
                <button
                  className="sx-button"
                  disabled={busy}
                  onClick={() =>
                    void run({ type: "explore", projectId, focusId: node.id, direction, hops: 2 })
                  }
                >
                  Explore neighborhood
                </button>
              </div>
              <label className="sx-field">
                Path destination
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose node</option>
                  {graph?.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="sx-button"
                disabled={busy || !target}
                onClick={() =>
                  void run({
                    type: "explore",
                    projectId,
                    focusId: node.id,
                    targetId: target,
                    direction,
                  })
                }
              >
                Find bounded path
              </button>
              <details>
                <summary>Review a relationship</summary>
                <label className="sx-field">
                  Relationship
                  <select value={predicate} onChange={(event) => setPredicate(event.target.value)}>
                    <option value="relates_to">Relates to</option>
                    <option value="same_as">Same as · retain both identities</option>
                    <option value="supersedes">Supersedes · retain both records</option>
                  </select>
                </label>
                <label className="sx-field">
                  Evidence and rationale
                  <textarea
                    value={rationale}
                    maxLength={1024}
                    onChange={(event) => setRationale(event.target.value)}
                  />
                </label>
                <button
                  className="sx-button"
                  disabled={busy || !graph || !target || target === node.id || !rationale.trim()}
                  onClick={() =>
                    graph &&
                    void run({
                      type: "align",
                      projectId,
                      expectedVersion: graph.settings.version,
                      edge: {
                        id: `alignment:${randomUUID()}`,
                        source: node.id,
                        target,
                        predicate,
                        provenance: "manual",
                        rationale: rationale.trim(),
                        reviewed: true,
                      },
                    })
                  }
                >
                  Accept reviewed relationship
                </button>
              </details>
              <ul>
                {graph?.edges
                  .filter((e) => e.source === node.id || e.target === node.id)
                  .map((e) => (
                    <li key={e.id}>
                      {e.directed === false ? "BOTH ↔" : e.source === node.id ? "OUT →" : "IN ←"}{" "}
                      {e.predicate} · {e.provenance} · {e.rationale}
                      {e.provenance === "manual" && (
                        <button
                          className="sx-button"
                          disabled={busy}
                          onClick={() =>
                            graph &&
                            void run({
                              type: "unalign",
                              projectId,
                              expectedVersion: graph.settings.version,
                              id: e.id,
                              reason: "Revoked after relationship review",
                            })
                          }
                        >
                          Revoke relationship
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
              <button
                className="sx-button sx-button-primary"
                disabled={busy || !graph}
                onClick={() =>
                  graph &&
                  void run({
                    type: "select",
                    projectId,
                    expectedVersion: graph.settings.version,
                    ids: graph.settings.pinned.includes(node.id)
                      ? graph.settings.pinned.filter((id) => id !== node.id)
                      : [...graph.settings.pinned, node.id],
                  })
                }
              >
                {graph?.settings.pinned.includes(node.id)
                  ? "Remove from future context"
                  : "Pin for future attempts"}
              </button>
            </>
          ) : (
            <p className="sx-empty">Select a node to inspect its source and relationships.</p>
          )}
        </div>
      </div>
      {graph && (
        <details>
          <summary>Project graph sources and recall</summary>
          <label className="sx-field">
            Import local SynthBrain graph export
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy || !graph.settings.enabledSources.includes("synthbrain")}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 100_000)
                    throw new Error(
                      "Export exceeds 100 KB; create a smaller approved graph export.",
                    );
                  const data = decodeBrain(await file.text());
                  await run({
                    type: "import_brain",
                    projectId,
                    expectedVersion: graph.settings.version,
                    data,
                  });
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Invalid export");
                }
                event.target.value = "";
              }}
            />
          </label>
          <p>
            Source snapshots stay on this host. Changing scope affects future attempts; frozen
            attempts retain their evidence.
          </p>
          <label className="sx-field">
            Approved SynthBrain vault folders · one per line
            <textarea value={folders} onChange={(e) => setFolders(e.target.value)} rows={3} />
          </label>
          <div className="sx-actions">
            {(["synthome", "synthbrain"] as const).map((source) => (
              <button
                key={source}
                className="sx-button"
                disabled={busy}
                aria-pressed={graph.settings.enabledSources.includes(source)}
                onClick={() =>
                  void run({
                    type: "configure",
                    settings: {
                      ...graph.settings,
                      approvedFolders: folders
                        .split("\n")
                        .map((f) => f.trim())
                        .filter(Boolean),
                      enabledSources: graph.settings.enabledSources.includes(source)
                        ? graph.settings.enabledSources.filter((s) => s !== source)
                        : [...graph.settings.enabledSources, source],
                    },
                  })
                }
              >
                {graph.settings.enabledSources.includes(source) ? "Disconnect" : "Enable"} {source}
              </button>
            ))}
            <button
              className="sx-button"
              disabled={busy}
              onClick={() =>
                void run({
                  type: "configure",
                  settings: {
                    ...graph.settings,
                    approvedFolders: folders
                      .split("\n")
                      .map((f) => f.trim())
                      .filter(Boolean),
                  },
                })
              }
            >
              Save folders
            </button>
            <button
              className="sx-button"
              disabled={busy}
              aria-pressed={graph.settings.autoRecall}
              onClick={() =>
                void run({
                  type: "configure",
                  settings: { ...graph.settings, autoRecall: !graph.settings.autoRecall },
                })
              }
            >
              Automatic graph recall: {graph.settings.autoRecall ? "on" : "off"}
            </button>
            <button
              className="sx-button"
              disabled={busy || !graph.settings.pinned.length}
              onClick={() =>
                void run({
                  type: "select",
                  projectId,
                  expectedVersion: graph.settings.version,
                  ids: [],
                })
              }
            >
              Clear pins
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
