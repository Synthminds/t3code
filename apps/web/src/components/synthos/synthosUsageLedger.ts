import type {
  OrchestrationV2ThreadProjection,
  SynthosAttempt,
  SynthosWorkflow,
} from "@t3tools/contracts";
import { tokenMonitorNativeId, type TokenMonitorExport } from "@t3tools/shared/tokenMonitorExport";

export function synthosUsageLedger(workflow: {
  readonly attempts: readonly SynthosAttempt[];
  readonly usage: Pick<SynthosWorkflow["usage"], "incompleteUsage">;
}) {
  const identities = new Set<string>();
  const threads = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let completeAttempts = 0;
  let duplicateAttempts = 0;
  for (const attempt of workflow.attempts) {
    if (identities.has(attempt.id) || threads.has(attempt.threadId)) {
      duplicateAttempts += 1;
      continue;
    }
    identities.add(attempt.id);
    threads.add(attempt.threadId);
    inputTokens += attempt.inputTokens;
    outputTokens += attempt.outputTokens;
    if (attempt.usageComplete) completeAttempts += 1;
  }
  return {
    inputTokens,
    outputTokens,
    completeAttempts,
    unknownAttempts: identities.size - completeAttempts,
    duplicateAttempts,
    complete:
      !workflow.usage.incompleteUsage &&
      duplicateAttempts === 0 &&
      completeAttempts === identities.size &&
      identities.size > 0,
  };
}

type Reconciliation =
  | { readonly kind: "unmatched" | "ambiguous"; readonly reason: string }
  | {
      readonly kind: "matched";
      readonly tool: string;
      readonly nativeId: string;
      readonly exportTokens: number | null;
      readonly exportCostUsd: number | null;
      readonly recordedTokens: number;
      readonly difference: number | null;
      readonly reason: string;
    };

type UsageProjection = {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "id">;
  readonly providerThreads: readonly Pick<
    OrchestrationV2ThreadProjection["providerThreads"][number],
    "appThreadId" | "nativeThreadRef" | "driver"
  >[];
  readonly runs: readonly unknown[];
  readonly subagents: readonly unknown[];
  readonly providerTurns: readonly {
    readonly turnTokenUsage?:
      | {
          readonly usageStatus?: string | undefined;
          readonly hasSubagents?: boolean | undefined;
        }
      | null
      | undefined;
  }[];
};

export function reconcileSynthosAttempt(
  attempt: SynthosAttempt,
  projection: UsageProjection,
  report: TokenMonitorExport,
  workflowUpdatedAt: number,
): Reconciliation {
  if (projection.thread.id !== attempt.threadId) {
    return { kind: "unmatched", reason: "Thread identity does not match this attempt." };
  }
  const identities = new Map<string, { tool: string; nativeId: string }>();
  for (const providerThread of projection.providerThreads) {
    const ref = providerThread.nativeThreadRef;
    if (
      providerThread.appThreadId !== attempt.threadId ||
      ref?.strength !== "strong" ||
      !ref.nativeId ||
      ref.driver !== providerThread.driver
    )
      continue;
    // Custom ACP providers cannot be attributed from their display names.
    const client =
      ref.driver === "codex" ? "codex" : ref.driver === "claudeAgent" ? "claude" : null;
    if (client === null) continue;
    const nativeId = tokenMonitorNativeId(client, ref.nativeId);
    identities.set(`${client}:${nativeId}`, { tool: client, nativeId });
  }
  if (identities.size !== 1) {
    return {
      kind: identities.size > 1 ? "ambiguous" : "unmatched",
      reason:
        identities.size > 1
          ? "Multiple native conversations exist; no automatic attribution."
          : "No supported, strong native session identity is available.",
    };
  }
  const identity = [...identities.values()][0]!;
  const matches = report.periods.allTime.sessions.filter(
    (session) =>
      session.tool === identity.tool &&
      session.sessionId !== null &&
      tokenMonitorNativeId(identity.tool, session.sessionId) === identity.nativeId,
  );
  if (matches.length !== 1) {
    return {
      kind: matches.length > 1 ? "ambiguous" : "unmatched",
      reason:
        matches.length > 1
          ? "Multiple exported records share this native identity; none were added together."
          : "The all-time export has no exact native session match. Missing usage is unknown.",
    };
  }
  const session = matches[0]!;
  const recordedTokens = attempt.inputTokens + attempt.outputTokens;
  const isComplete =
    attempt.usageComplete &&
    !["pending", "running"].includes(attempt.status) &&
    projection.runs.length === 1 &&
    projection.subagents.length === 0 &&
    projection.providerTurns.length > 0 &&
    projection.providerTurns.every(
      (turn) =>
        turn.turnTokenUsage?.usageStatus === "complete" && !turn.turnTokenUsage.hasSubagents,
    );
  const fresh = Date.parse(report.generatedAt) >= workflowUpdatedAt;
  return {
    kind: "matched",
    ...identity,
    exportTokens: session.totalTokens,
    exportCostUsd: session.costUsd,
    recordedTokens,
    difference:
      isComplete && fresh && session.totalTokens !== null
        ? session.totalTokens - recordedTokens
        : null,
    reason: !fresh
      ? "Export predates the latest mission update; refresh it before comparing."
      : !isComplete
        ? "Native coverage is incomplete or includes subagents. Difference is unknown."
        : session.totalTokens === null
          ? "Exported session total is unknown."
          : "Difference is advisory: cache accounting and collection coverage can differ. It is not a billing receipt.",
  };
}
