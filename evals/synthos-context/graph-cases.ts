import { ProjectId, type SynthosGraphSnapshot } from "@t3tools/contracts";
import { scopedGraph } from "../../apps/server/src/synthos-graph/graph.ts";
const snapshot: SynthosGraphSnapshot = {
  source: "synthbrain",
  revision: "synthetic-graph",
  partial: true,
  nodes: [
    {
      id: "synthbrain:approved",
      originalId: "approved",
      source: "synthbrain",
      label: "Knowledge graph provenance",
      body: "Preserve original typed assertions and distinguish inferred similarity from reviewed evidence.",
      kind: "note",
      ref: "Projects/acme/provenance.md",
      revision: "synthetic-1",
      sensitivity: "private",
      review: "reviewed",
      provenance: "extracted",
    },
    {
      id: "synthbrain:excluded",
      originalId: "excluded",
      source: "synthbrain",
      label: "Knowledge graph private unrelated",
      body: "Excluded project memory must not cross the approved boundary.",
      kind: "note",
      ref: "Private/other-project.md",
      revision: "synthetic-2",
      sensitivity: "private",
      review: "pending",
      provenance: "extracted",
    },
  ],
  edges: [],
};
const graph = scopedGraph([snapshot], [], {
  projectId: ProjectId.make("synthetic-acme"),
  version: 1,
  enabledSources: ["synthbrain"],
  approvedFolders: ["Projects/acme"],
  autoRecall: true,
  pinned: [],
});
const notes = graph.nodes.map((node) => ({
  path: node.id,
  content: `# ${node.label}\n${node.body}`,
  version: node.revision,
  tier: 2 as const,
}));
export const graphCases = [
  {
    id: "graph-approved-evidence",
    source:
      "Graph integration: scoped source evidence reaches the GCH packet with provenance guidance.",
    task: "Inspect knowledge graph provenance",
    role: "docs",
    notes,
    expectedRoutes: ["memory"],
    expectedNotes: ["synthbrain:approved"],
    excludedNotes: ["synthbrain:excluded"],
  },
  {
    id: "graph-unrelated-control",
    source:
      "Graph integration negative control: no relevant source is better than unrelated graph context.",
    task: "Describe a lunch menu",
    role: "docs",
    notes,
    expectedRoutes: [],
    expectedNotes: [],
    excludedNotes: ["synthbrain:approved", "synthbrain:excluded"],
  },
] as const;
