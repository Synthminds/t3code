import { CommandId, ProviderDriverKind, ThreadId, type SynthosAttempt } from "@t3tools/contracts";
import { parseTokenMonitorExport } from "@t3tools/shared/tokenMonitorExport";
import { describe, expect, it } from "vite-plus/test";

import { reconcileSynthosAttempt, synthosUsageLedger } from "./synthosUsage";

const attempt: SynthosAttempt = {
  id: "attempt-1",
  commandId: CommandId.make("command-1"),
  threadId: ThreadId.make("thread-1"),
  role: "lead",
  stage: "build",
  status: "completed",
  loop: 1,
  inputReserved: 100,
  outputReserved: 100,
  inputTokens: 20,
  outputTokens: 10,
  usageComplete: true,
  result: "",
  evidenceHash: null,
  candidateRef: null,
  checkPassed: null,
  packetHtml: "",
  packetHash: "hash",
};

function projection() {
  return {
    thread: { id: attempt.threadId },
    runs: [{}],
    subagents: [],
    providerThreads: [
      {
        appThreadId: attempt.threadId,
        driver: ProviderDriverKind.make("codex"),
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          strength: "strong" as const,
          nativeId: "native-1",
        },
      },
    ],
    providerTurns: [{ turnTokenUsage: { usageStatus: "complete", hasSubagents: false } }],
  };
}

function report(
  sessions: Record<string, unknown> = {
    native: { client: "codex", sessionId: "native-1", totalTokens: 35 },
  },
) {
  return parseTokenMonitorExport(
    JSON.stringify({
      app: { name: "token-monitor", version: "0.80.0" },
      generatedAt: "2026-10-28T12:00:00.000Z",
      snapshot: { allTime: { totalTokens: 9999, sessions } },
    }),
  );
}

describe("mission usage reconciliation", () => {
  it("excludes repeated attempt and thread identities while keeping incomplete receipts unknown", () => {
    const ledger = synthosUsageLedger({
      usage: { incompleteUsage: true },
      attempts: [
        attempt,
        attempt,
        { ...attempt, id: "same-thread" },
        {
          ...attempt,
          id: "missing-usage",
          threadId: ThreadId.make("other-thread"),
          inputTokens: 0,
          outputTokens: 0,
          usageComplete: false,
        },
      ],
    });
    expect(ledger).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      completeAttempts: 1,
      unknownAttempts: 1,
      duplicateAttempts: 2,
      complete: false,
    });
    expect(synthosUsageLedger({ usage: { incompleteUsage: false }, attempts: [] }).complete).toBe(
      false,
    );
  });
  it("matches strong native IDs and compares only the selected session, never the aggregate", () => {
    expect(reconcileSynthosAttempt(attempt, projection(), report(), 0)).toMatchObject({
      kind: "matched",
      nativeId: "native-1",
      recordedTokens: 30,
      exportTokens: 35,
      difference: 5,
    });
  });

  it("does not substitute app thread IDs or infer missing native session IDs from map keys", () => {
    expect(
      reconcileSynthosAttempt(
        attempt,
        projection(),
        report({
          native: { client: "codex", sessionId: "thread-1", totalTokens: 30 },
          "codex:native-1": { client: "codex", totalTokens: 30 },
        }),
        0,
      ).kind,
    ).toBe("unmatched");
  });

  it("rejects weak, wrong-provider and ambiguous native relationships", () => {
    const base = projection();
    const providerThread = base.providerThreads[0]!;
    expect(
      reconcileSynthosAttempt(
        attempt,
        {
          ...base,
          providerThreads: [
            {
              ...providerThread,
              nativeThreadRef: { ...providerThread.nativeThreadRef, strength: "weak" },
            },
          ],
        },
        report(),
        0,
      ).kind,
    ).toBe("unmatched");
    expect(
      reconcileSynthosAttempt(
        attempt,
        {
          ...base,
          providerThreads: [
            {
              ...providerThread,
              nativeThreadRef: {
                ...providerThread.nativeThreadRef,
                driver: ProviderDriverKind.make("claudeAgent"),
              },
            },
          ],
        },
        report(),
        0,
      ).kind,
    ).toBe("unmatched");
    expect(
      reconcileSynthosAttempt(
        attempt,
        {
          ...base,
          providerThreads: [
            ...base.providerThreads,
            {
              ...providerThread,
              nativeThreadRef: { ...providerThread.nativeThreadRef, nativeId: "other" },
            },
          ],
        },
        report(),
        0,
      ).kind,
    ).toBe("ambiguous");
  });

  it("does not add duplicate exported identities or parent and subagent spend", () => {
    expect(
      reconcileSynthosAttempt(
        attempt,
        projection(),
        report({
          first: { client: "codex", sessionId: "native-1", totalTokens: 35 },
          second: { client: "codex", sessionId: "native-1", totalTokens: 35 },
        }),
        0,
      ).kind,
    ).toBe("ambiguous");
    expect(
      reconcileSynthosAttempt(attempt, { ...projection(), subagents: [{}] }, report(), 0),
    ).toMatchObject({ kind: "matched", difference: null });
    expect(
      reconcileSynthosAttempt(
        attempt,
        {
          ...projection(),
          providerTurns: [
            {
              turnTokenUsage: { usageStatus: "complete", hasSubagents: true },
            },
          ],
        },
        report(),
        0,
      ),
    ).toMatchObject({ kind: "matched", difference: null });
  });

  it("keeps missing, incomplete, running and stale observations unknown", () => {
    expect(
      reconcileSynthosAttempt(
        attempt,
        projection(),
        report({ native: { client: "codex", sessionId: "native-1" } }),
        0,
      ),
    ).toMatchObject({ kind: "matched", exportTokens: null, difference: null });
    expect(
      reconcileSynthosAttempt({ ...attempt, usageComplete: false }, projection(), report(), 0),
    ).toMatchObject({ kind: "matched", difference: null });
    expect(
      reconcileSynthosAttempt({ ...attempt, status: "running" }, projection(), report(), 0),
    ).toMatchObject({ kind: "matched", difference: null });
    expect(
      reconcileSynthosAttempt(attempt, projection(), report(), Date.parse("2026-10-28T13:00:00Z")),
    ).toMatchObject({ kind: "matched", difference: null });
    expect(attempt.inputTokens).toBe(20);
    expect(attempt.inputReserved).toBe(100);
  });
});
