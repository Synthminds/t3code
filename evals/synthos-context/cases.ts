import { graphCases } from "./graph-cases.ts";
import type { MemoryNote } from "../../apps/server/src/synthos-context/retrieval.ts";

const projectNote: MemoryNote = {
  path: "Projects/acme/vault-conflicts.md",
  content:
    "# Obsidian vault conflicts\n\nReload the note version before replacing a changed vault note.",
  version: "synthetic-1",
  tier: 1,
};
const neighborhoodNote: MemoryNote = {
  path: "Neighborhoods/storage/vault-writes.md",
  content: "# Obsidian vault writes\n\nA vault write must retain the reviewed expected version.",
  version: "synthetic-2",
  tier: 2,
};
const unrelatedNote: MemoryNote = {
  path: "Projects/acme/lunch.md",
  content: "# Lunch schedule\n\nThe team eats sandwiches on Tuesday.",
  version: "synthetic-3",
  tier: 1,
};

export const cases = [
  ...graphCases,
  {
    id: "ordinary-task-no-route",
    source: "Control: an unrelated task must not force repository routing or memory recall.",
    task: "Explain a changelog sentence",
    role: "docs",
    notes: [projectNote, neighborhoodNote, unrelatedNote],
    expectedRoutes: [],
    expectedNotes: [],
    excludedNotes: [projectNote.path, neighborhoodNote.path, unrelatedNote.path],
  },
  {
    id: "project-before-neighborhood",
    source:
      "Approved SynthOS tiered-recall plan: project evidence first, neighborhoods below three matches.",
    task: "Fix Obsidian vault conflicts",
    role: "crew",
    notes: [neighborhoodNote, unrelatedNote, projectNote],
    expectedRoutes: ["memory"],
    expectedNotes: [projectNote.path, neighborhoodNote.path],
    excludedNotes: [unrelatedNote.path],
  },
  {
    id: "sufficient-project-context",
    source:
      "Approved SynthOS plan: three qualifying project notes suppress neighborhood expansion.",
    task: "Fix Obsidian vault conflicts",
    role: "crew",
    notes: [
      projectNote,
      {
        ...projectNote,
        path: "Projects/acme/versions.md",
        content: "# Obsidian vault versions\n\nRetain note versions in provenance.",
      },
      {
        ...projectNote,
        path: "Projects/acme/paths.md",
        content: "# Obsidian vault paths\n\nReject paths outside the allowed vault.",
      },
      neighborhoodNote,
    ],
    expectedRoutes: ["memory"],
    expectedNotes: [projectNote.path, "Projects/acme/versions.md", "Projects/acme/paths.md"],
    excludedNotes: [neighborhoodNote.path],
  },
  {
    id: "ordinary-ui-no-memory",
    source: "Control: a UI-only task must not inherit unrelated vault memories.",
    task: "Adjust cockpit theme contrast",
    role: "crew",
    notes: [projectNote, neighborhoodNote, unrelatedNote],
    expectedRoutes: ["ui"],
    expectedNotes: [],
    excludedNotes: [projectNote.path, neighborhoodNote.path, unrelatedNote.path],
  },
  {
    id: "cross-boundary-context",
    source: "Approved routing plan: investigate all matching boundaries for cross-cutting tasks.",
    task: "Show Obsidian memory in the cockpit UI",
    role: "reviewer",
    notes: [projectNote, unrelatedNote],
    expectedRoutes: ["memory", "ui"],
    expectedNotes: [],
    excludedNotes: [unrelatedNote.path],
  },
  {
    id: "duplicate-memory",
    source: "Approved context plan: copied notes must not consume context twice.",
    task: "Fix Obsidian vault conflicts",
    role: "lead",
    notes: [
      projectNote,
      { ...projectNote, path: "Neighborhoods/storage/copy.md", tier: 2 as const },
    ],
    expectedRoutes: ["memory"],
    expectedNotes: [projectNote.path],
    excludedNotes: ["Neighborhoods/storage/copy.md"],
  },
] as const;
