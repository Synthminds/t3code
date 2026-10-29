import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type SynthosGraphSnapshot,
  type SynthosGraphSettings,
} from "@t3tools/contracts";
import { importBrain } from "./synthbrain.ts";
import { scopedGraph, exploreGraph, validateSnapshot } from "./graph.ts";
const settings: SynthosGraphSettings = {
  projectId: ProjectId.make("graph-project"),
  version: 1,
  enabledSources: ["synthbrain"],
  approvedFolders: ["Projects/A"],
  autoRecall: false,
  pinned: [],
};
const snapshot: SynthosGraphSnapshot = {
  source: "synthbrain",
  revision: "r1",
  partial: false,
  nodes: ["a", "b", "secret"].map((id) => ({
    id: `synthbrain:${id}`,
    originalId: id,
    source: "synthbrain",
    label: "Same title",
    body: "",
    kind: "note",
    ref: id === "secret" ? "Private/secret.md" : `Projects/A/${id}.md`,
    revision: "r1",
    sensitivity: "private",
    review: "unreviewed",
    provenance: "extracted",
  })),
  edges: [
    {
      id: "edge-1",
      source: "synthbrain:a",
      target: "synthbrain:b",
      predicate: "mentions",
      provenance: "extracted",
      rationale: "explicit",
      reviewed: false,
    },
    {
      id: "edge-2",
      source: "synthbrain:a",
      target: "synthbrain:b",
      predicate: "similar",
      provenance: "inferred",
      rationale: "TF-IDF similarity",
      reviewed: false,
    },
    {
      id: "secret-edge",
      source: "synthbrain:b",
      target: "synthbrain:secret",
      predicate: "mentions",
      provenance: "extracted",
      rationale: "private",
      reviewed: false,
    },
  ],
};
it("filters scope before traversal, preserves parallel assertions and direction, and never merges equal titles", () => {
  const graph = scopedGraph([snapshot], [], settings);
  expect(graph.nodes.map((n) => n.id)).toEqual(["synthbrain:a", "synthbrain:b"]);
  expect(graph.edges.map((e) => e.id)).toEqual(["edge-1", "edge-2"]);
  expect(
    exploreGraph(graph, {
      type: "explore",
      projectId: settings.projectId,
      focusId: "synthbrain:b",
      direction: "outgoing",
      hops: 2,
    }).nodes.map((n) => n.id),
  ).toEqual(["synthbrain:b"]);
  expect(
    exploreGraph(graph, {
      type: "explore",
      projectId: settings.projectId,
      focusId: "synthbrain:a",
      targetId: "synthbrain:secret",
    }).nodes,
  ).toEqual([]);
  expect(
    exploreGraph(graph, { type: "explore", projectId: settings.projectId, query: "secret" }).nodes,
  ).toEqual([]);
  expect(
    exploreGraph(graph, {
      type: "explore",
      projectId: settings.projectId,
      focusId: "synthbrain:b",
      targetId: "synthbrain:a",
      direction: "outgoing",
    }).nodes,
  ).toEqual([]);
  expect(
    exploreGraph(graph, {
      type: "explore",
      projectId: settings.projectId,
      focusId: "synthbrain:b",
      targetId: "synthbrain:a",
      direction: "both",
    }).nodes,
  ).toHaveLength(2);
});
it("rejects forged identities, dangling endpoints and unsafe vault references", () => {
  expect(() => validateSnapshot(snapshot)).not.toThrow();
  expect(() =>
    validateSnapshot({ ...snapshot, nodes: [...snapshot.nodes, snapshot.nodes[0]!] }),
  ).toThrow();
  expect(() => validateSnapshot({ ...snapshot, nodes: snapshot.nodes.slice(0, 1) })).toThrow();
  expect(() =>
    validateSnapshot({
      ...snapshot,
      nodes: snapshot.nodes.map((n) => ({ ...n, ref: "Projects/A/../../Private/x.md" })),
    }),
  ).toThrow();
});
it("bounds cyclic neighborhoods and marks incomplete coverage", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    ...snapshot.nodes[0]!,
    id: `synthbrain:n${i}`,
    originalId: `n${i}`,
  }));
  const edges = nodes.map((n, i) => ({
    ...snapshot.edges[0]!,
    id: `e${i}`,
    source: nodes[0]!.id,
    target: n.id,
  }));
  const graph = scopedGraph([{ ...snapshot, nodes, edges }], [], settings);
  const result = exploreGraph(graph, {
    type: "explore",
    projectId: settings.projectId,
    focusId: nodes[0]!.id,
    hops: 2,
  });
  expect(result.nodes).toHaveLength(80);
  expect(result.partial).toBe(true);
  expect(scopedGraph([snapshot], [], { ...settings, enabledSources: [] }).nodes).toEqual([]);
});

it("retains undirected SynthBrain similarities when traversing in either direction", () => {
  const imported = importBrain(
    {
      nodes: [
        { id: "Projects/A/a.md", title: "A" },
        { id: "Projects/A/b.md", title: "B" },
      ],
      links: [{ source: "Projects/A/a.md", target: "Projects/A/b.md", value: 0.9 }],
    },
    settings,
  );
  const graph = scopedGraph([imported], [], settings);
  for (const direction of ["outgoing", "incoming", "both"] as const) {
    const result = exploreGraph(graph, {
      type: "explore",
      projectId: settings.projectId,
      focusId: "synthbrain:Projects/A/b.md",
      targetId: "synthbrain:Projects/A/a.md",
      direction,
    });
    expect(result.nodes).toHaveLength(2);
    expect(result.edges.map((edge) => edge.id)).toEqual(imported.edges.map((edge) => edge.id));
  }
});
