#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  parseRouting,
  selectMemories,
  selectRoutes,
} from "../../apps/server/src/synthos-context/retrieval.ts";
import {
  createGchPacket,
  GCH_POLICY,
  GCH_POLICY_INSPECTION,
} from "../../apps/server/src/synthos/gchPolicy.ts";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    case: { type: "string", multiple: true },
    braintrust: { type: "boolean", default: false },
    baseline: { type: "string" },
  },
});
if (!values.out)
  throw new Error(
    "Use --out <directory> [--case <id>] [--baseline <results.json>] [--braintrust].",
  );
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
if (selected.length === 0 || values.case?.some((id) => !cases.some((entry) => entry.id === id)))
  throw new Error("Unknown or empty case selection.");
const routes = parseRouting(
  await NodeFSP.readFile(new URL("../../ROUTING.md", import.meta.url), "utf8"),
);
const rows = selected.flatMap((entry) => {
  const memories = selectMemories(entry.notes, entry.task, entry.role);
  const routed = selectRoutes(routes, entry.task, entry.role);
  return (["packet-only-baseline", "routed-recall"] as const).map((variant) => {
    const current = variant === "routed-recall";
    const packet = createGchPacket({
      workflowId: "synthetic-context-eval",
      task: entry.task,
      role: entry.role,
      goal: "Return source references, observed verification, unresolved questions, and next sources to read.",
      context: [
        "Synthetic handoff: reviewed note writes retain an expected version. Full evidence remains in the T3 thread.",
        ...(current
          ? routed.map((route) => `Route ${route.id}; read ${route.load.join(", ")}.`)
          : []),
        ...(current
          ? memories.selected.map(
              (note) =>
                `Source ${note.path}; version ${note.version}; ${note.reason}\n${note.excerpt}`,
            )
          : []),
      ].join("\n\n"),
      checkCommands: ["approved-synthetic-check"],
    });
    const output = {
      routes: current ? routed.map((route) => route.id) : [],
      notes: current ? memories.selected.map((note) => note.path) : [],
      omissions: current ? memories.omitted : [],
      neighborhoodUsed: current && memories.neighborhoodUsed,
      memoryBytes: current ? memories.bytes : 0,
      packetBytes: Buffer.byteLength(packet.html, "utf8"),
      estimatedInputTokens: Math.ceil(
        Buffer.byteLength(`${GCH_POLICY.canonicalRules}\n\n${packet.html}`, "utf8") / 3,
      ),
      packetHash: packet.sha256,
      policyIntact:
        packet.policyHash === GCH_POLICY.sha256 &&
        NodeCrypto.createHash("sha256").update(GCH_POLICY.canonicalRules).digest("hex") ===
          GCH_POLICY_INSPECTION.canonicalRulesSha256,
    };
    return {
      id: entry.id,
      variant,
      input: { task: entry.task, role: entry.role },
      source: entry.source,
      output,
      ...grade({
        ...output,
        expectedRoutes: entry.expectedRoutes,
        expectedNotes: entry.expectedNotes,
        excludedNotes: entry.excludedNotes,
      }),
    };
  });
});

const result = {
  version: 1,
  kind: "synthetic-deterministic-context",
  modelCalls: 0,
  inferenceCostUsd: 0,
  rows,
};
await NodeFSP.mkdir(values.out, { recursive: true });
await NodeFSP.writeFile(
  NodePath.join(values.out, "results.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
const prior: unknown = values.baseline
  ? JSON.parse(await NodeFSP.readFile(values.baseline, "utf8"))
  : null;
if (
  prior !== null &&
  (typeof prior !== "object" ||
    !("kind" in prior) ||
    prior.kind !== result.kind ||
    !("version" in prior) ||
    prior.version !== 1)
)
  throw new Error("Baseline must be a version 1 synthetic context results.json.");
const summary = {
  ...Object.fromEntries(
    (["packet-only-baseline", "routed-recall"] as const).map((variant) => {
      const group = rows.filter((row) => row.variant === variant);
      return [
        variant,
        {
          passed: group.filter((row) => row.pass).length,
          total: group.length,
          packetBytes: group.reduce((sum, row) => sum + row.output.packetBytes, 0),
        },
      ];
    }),
  ),
  priorRun: prior,
  limits:
    "Deterministic source-selection benchmark, not a real-model quality or billing comparison. The baseline uses the production packet builder without routed sources or recall.",
};
await NodeFSP.writeFile(
  NodePath.join(values.out, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
if (values.braintrust) {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  const projectId = process.env.BRAINTRUST_PROJECT_ID;
  if (!apiKey || !projectId)
    throw new Error(
      "Local results saved. Set BRAINTRUST_API_KEY and BRAINTRUST_PROJECT_ID for explicit synthetic upload.",
    );
  const { init } = await import("braintrust");
  const experiment = init({
    projectId,
    apiKey,
    appUrl: "https://www.braintrust.dev",
    experiment: `synthos-context-${NodeCrypto.randomUUID()}`,
    description:
      "Synthetic deterministic repository routing and tiered recall; no model calls or real vault content.",
    isPublic: false,
    setCurrent: false,
    gitMetadataSettings: { collect: "none" },
  });
  for (const row of rows)
    experiment.log({
      input: row.input,
      output: row.output,
      scores: row.scores,
      metadata: { caseId: row.id, variant: row.variant, synthetic: true, modelCalls: 0 },
    });
  await experiment.flush();
  process.stdout.write("Synthetic context evaluation uploaded to Braintrust.\n");
}
process.stdout.write(
  JSON.stringify(
    { out: values.out, ...summary, priorRun: prior === null ? null : "loaded" },
    null,
    2,
  ) + "\n",
);
if (rows.some((row) => row.variant === "routed-recall" && !row.pass)) process.exitCode = 1;
