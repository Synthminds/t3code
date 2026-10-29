import type {
  SynthosGraphNode,
  SynthosGraphEdge,
  SynthosGraphSettings,
  SynthosGraphSnapshot,
  SynthosGraphCommand,
} from "@t3tools/contracts";
import { digest } from "../synthos-context/manifest.ts";

export function scopedGraph(
  snapshots: readonly SynthosGraphSnapshot[],
  alignments: readonly SynthosGraphEdge[],
  settings: SynthosGraphSettings,
) {
  const nodes = snapshots
    .filter((s) => settings.enabledSources.includes(s.source))
    .flatMap((s) => s.nodes)
    .filter((n) =>
      n.source === "synthome"
        ? n.sensitivity === "public"
        : settings.approvedFolders.some((f) => n.ref === f || n.ref.startsWith(`${f}/`)),
    );
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...snapshots.flatMap((s) => s.edges), ...alignments].filter(
    (e) => ids.has(e.source) && ids.has(e.target),
  );
  return {
    nodes,
    edges,
    partial:
      snapshots.some((s) => s.partial) ||
      settings.enabledSources.some((s) => !snapshots.some((g) => g.source === s)),
    revision: digest(JSON.stringify({ nodes, edges, settings })),
  };
}
export function exploreGraph(
  graph: ReturnType<typeof scopedGraph>,
  command: Extract<SynthosGraphCommand, { type: "explore" }>,
) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const direction = command.direction ?? "both";
  const links = (id: string) =>
    graph.edges.filter(
      (e) =>
        (e.directed === false && (e.source === id || e.target === id)) ||
        (direction !== "incoming" && e.source === id) ||
        (direction !== "outgoing" && e.target === id),
    );
  let selected: SynthosGraphNode[];
  let pathEdges: SynthosGraphEdge[] | undefined;
  let truncated = false;
  if (command.focusId) {
    const root = byId.get(command.focusId);
    selected = root ? [root] : [];
    const seen = new Set(selected.map((n) => n.id));
    const queue = selected.map((n) => ({ id: n.id, depth: 0, path: [] as SynthosGraphEdge[] }));
    if (command.targetId) selected = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!;
      if (command.targetId === current.id) {
        pathEdges = current.path;
        selected = [
          ...new Set([command.focusId, ...pathEdges.flatMap((e) => [e.source, e.target])]),
        ].map((id) => byId.get(id)!);
        break;
      }
      if (current.depth >= (command.targetId ? 4 : (command.hops ?? 1))) continue;
      for (const edge of links(current.id)) {
        const next = edge.source === current.id ? edge.target : edge.source;
        if (seen.has(next)) continue;
        if (seen.size >= 80) {
          truncated = true;
          continue;
        }
        seen.add(next);
        queue.push({ id: next, depth: current.depth + 1, path: [...current.path, edge] });
        if (!command.targetId) selected.push(byId.get(next)!);
      }
    }
  } else {
    const query = (command.query ?? "").toLowerCase().trim();
    const found = graph.nodes
      .filter((n) => `${n.label} ${n.body} ${n.kind}`.toLowerCase().includes(query))
      .sort((a, b) => a.id.localeCompare(b.id));
    selected = found.slice(0, 80);
    truncated = found.length > 80;
  }
  const ids = new Set(selected.map((n) => n.id));
  const edges = pathEdges ?? graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return {
    ...graph,
    nodes: selected,
    edges: edges.slice(0, 240),
    partial: graph.partial || truncated || edges.length > 240,
  };
}
export function validateSnapshot(snapshot: SynthosGraphSnapshot) {
  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    if (
      node.source !== snapshot.source ||
      node.id !== `${node.source}:${node.originalId}` ||
      ids.has(node.id) ||
      (node.source === "synthbrain" &&
        (node.ref.startsWith("/") ||
          node.ref.split("/").some((p) => !p || p === ".." || p === ".") ||
          /[\\\x00-\x1f]/.test(node.ref)))
    )
      throw new Error("invalid_graph_node");
    ids.add(node.id);
  }
  const edges = new Set<string>();
  for (const edge of snapshot.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edges.has(edge.id))
      throw new Error("invalid_graph_edge");
    edges.add(edge.id);
  }
}
