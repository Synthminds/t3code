import type {
  SynthosBrainExport,
  SynthosGraphSettings,
  SynthosGraphSnapshot,
} from "@t3tools/contracts";
import { digest } from "../synthos-context/manifest.ts";
export function importBrain(
  data: SynthosBrainExport,
  settings: SynthosGraphSettings,
): SynthosGraphSnapshot {
  const revision = digest(JSON.stringify(data));
  const allowed = data.nodes.filter((n) =>
    settings.approvedFolders.some((f) => n.id === f || n.id.startsWith(`${f}/`)),
  );
  const ids = new Set(allowed.map((n) => n.id));
  return {
    source: "synthbrain",
    revision,
    partial: allowed.length < data.nodes.length,
    nodes: allowed.map((n) => ({
      id: `synthbrain:${n.id}`,
      originalId: n.id,
      source: "synthbrain",
      label: n.title,
      body: "",
      kind: n.group ?? "note",
      ref: n.id,
      revision,
      sensitivity: "local_only",
      review: "unreviewed",
      provenance: "extracted",
    })),
    edges: data.links
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e, i) => ({
        id: `synthbrain:similar:${i}:${digest(`${e.source}:${e.target}`).slice(0, 16)}`,
        source: `synthbrain:${e.source}`,
        target: `synthbrain:${e.target}`,
        predicate: "similar",
        directed: false,
        provenance: "inferred",
        rationale: `SynthBrain TF-IDF cosine similarity ${e.value}; not a factual assertion`,
        reviewed: false,
      })),
  };
}
