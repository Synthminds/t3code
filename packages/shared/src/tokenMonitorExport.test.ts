import { describe, expect, it } from "vite-plus/test";

import {
  parseTokenMonitorExport,
  TOKEN_MONITOR_EXPORT_MAX_BYTES,
  tokenMonitorExportSummary,
  tokenMonitorNativeId,
} from "./tokenMonitorExport.ts";

const envelope = {
  app: { name: "token-monitor", version: "0.80.0" },
  generatedAt: "2026-10-28T12:00:00.000Z",
};

describe("official Token Monitor export adapter", () => {
  it("preserves overlapping periods without adding dimensions or inventing missing totals", () => {
    const report = parseTokenMonitorExport(
      JSON.stringify({
        ...envelope,
        snapshot: {
          today: { totalTokens: 30, costUsd: 0, clients: { codex: 30 }, models: { sol: 30 } },
          month: { totalTokens: 300 },
          allTime: {},
        },
        daily: [{ tokens: 1000 }],
      }),
    );
    expect(report.periods.today).toEqual({ totalTokens: 30, costUsd: 0, sessions: [] });
    expect(report.periods.month.totalTokens).toBe(300);
    expect(report.periods.allTime.totalTokens).toBeNull();
    expect(tokenMonitorExportSummary(report).workflowBudgetsChanged).toBe(false);
  });

  it("retains explicit native identities while stripping arbitrary text and not guessing IDs from keys", () => {
    const report = parseTokenMonitorExport(
      JSON.stringify({
        ...envelope,
        snapshot: {
          allTime: {
            sessions: {
              "codex:abc": {
                client: "codex",
                sessionId: "abc",
                totalTokens: 20,
                costUsd: 2,
                title: "private",
                accountEmail: "secret",
              },
              "codex:legacy": { client: "codex", totalTokens: 10 },
            },
          },
        },
      }),
    );
    expect(report.periods.allTime.sessions).toEqual([
      { tool: "codex", sessionId: "abc", totalTokens: 20, costUsd: 2 },
      { tool: "codex", sessionId: null, totalTokens: 10, costUsd: null },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/private|secret|accountEmail/u);
  });

  it.each([-1, 1.5, "42", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed token totals: %s",
    (totalTokens) => {
      expect(() =>
        parseTokenMonitorExport(
          JSON.stringify({ ...envelope, snapshot: { today: { totalTokens } } }),
        ),
      ).toThrow();
    },
  );

  it("rejects malformed envelopes, timestamps, excessive records and byte size", () => {
    for (const body of [
      "{",
      JSON.stringify({ ...envelope, app: { name: "other", version: "1" }, snapshot: {} }),
      JSON.stringify({ ...envelope, generatedAt: "yesterday", snapshot: {} }),
      JSON.stringify({
        ...envelope,
        snapshot: {
          today: {
            sessions: Object.fromEntries(
              Array.from({ length: 5001 }, (_, index) => [String(index), {}]),
            ),
          },
        },
      }),
      "界".repeat(Math.ceil(TOKEN_MONITOR_EXPORT_MAX_BYTES / 3)),
    ])
      expect(() => parseTokenMonitorExport(body)).toThrow();
  });

  it("normalizes only known UUID accounting identities, preserving opaque case", () => {
    expect(tokenMonitorNativeId("codex", "ABCDEF01-ABCD-1234-1234-123456ABCDEF")).toBe(
      "abcdef01-abcd-1234-1234-123456abcdef",
    );
    expect(tokenMonitorNativeId("codex", "OpaqueID")).toBe("OpaqueID");
    expect(tokenMonitorNativeId("opencode", "ABCDEF01-ABCD-1234-1234-123456ABCDEF")).toBe(
      "ABCDEF01-ABCD-1234-1234-123456ABCDEF",
    );
  });
});
