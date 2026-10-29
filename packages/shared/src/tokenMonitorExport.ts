import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export const TOKEN_MONITOR_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
export const TOKEN_MONITOR_PERIODS = ["today", "month", "allTime"] as const;
export type TokenMonitorPeriodName = (typeof TOKEN_MONITOR_PERIODS)[number];

export interface TokenMonitorSession {
  readonly tool: string | null;
  readonly sessionId: string | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface TokenMonitorPeriod {
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly sessions: readonly TokenMonitorSession[];
}

export interface TokenMonitorExport {
  readonly generatedAt: string;
  readonly version: string;
  readonly periods: Readonly<Record<TokenMonitorPeriodName, TokenMonitorPeriod>>;
}

export class TokenMonitorExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenMonitorExportError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TokenMonitorExportError("Expected a Token Monitor JSON export object.");
  }
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown, integer: boolean): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new TokenMonitorExportError("Usage counters must be finite, nonnegative numbers.");
  }
  return value;
}

function identifier(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\p{Control}\s]/u.test(value)
  ) {
    throw new TokenMonitorExportError("The export contains an invalid session identifier.");
  }
  return value;
}

function parsePeriod(value: unknown): TokenMonitorPeriod {
  const period = value === undefined ? {} : record(value);
  const entries = period.sessions === undefined ? [] : Object.entries(record(period.sessions));
  if (entries.length > 5_000) {
    throw new TokenMonitorExportError("Export exceeds 5,000 sessions per period.");
  }
  const sessions = entries.map(([, value]) => {
    const session = record(value);
    return {
      tool: session.client == null ? null : identifier(session.client, 64),
      sessionId: session.sessionId == null ? null : identifier(session.sessionId, 512),
      totalTokens: optionalNumber(session.totalTokens, true),
      costUsd: optionalNumber(session.costUsd, false),
    };
  });
  return {
    totalTokens: optionalNumber(period.totalTokens, true),
    costUsd: optionalNumber(period.costUsd, false),
    sessions,
  };
}

// Official snapshot periods and dimensions overlap; preserve them separately, never add them.
export function parseTokenMonitorExport(text: string): TokenMonitorExport {
  if (new TextEncoder().encode(text).byteLength > TOKEN_MONITOR_EXPORT_MAX_BYTES) {
    throw new TokenMonitorExportError("Token Monitor exports must be at most 2 MiB.");
  }
  let parsed: unknown;
  try {
    parsed = decodeJson(text);
  } catch {
    throw new TokenMonitorExportError("Select a valid token-monitor-export.json file.");
  }
  const envelope = record(parsed);
  const app = record(envelope.app);
  if (app.name !== "token-monitor" || typeof app.version !== "string" || app.version.length > 64) {
    throw new TokenMonitorExportError("This file is not an official Token Monitor export.");
  }
  if (
    typeof envelope.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(envelope.generatedAt) ||
    !Number.isFinite(Date.parse(envelope.generatedAt))
  ) {
    throw new TokenMonitorExportError("The export is missing a valid generation timestamp.");
  }
  const snapshot = record(envelope.snapshot);
  return {
    generatedAt: DateTime.formatIso(DateTime.makeUnsafe(envelope.generatedAt)),
    version: app.version,
    periods: {
      today: parsePeriod(snapshot.today),
      month: parsePeriod(snapshot.month),
      allTime: parsePeriod(snapshot.allTime),
    },
  };
}

export function tokenMonitorExportSummary(report: TokenMonitorExport) {
  return {
    source: "token-monitor-export" as const,
    generatedAt: report.generatedAt,
    version: report.version,
    periods: Object.fromEntries(
      TOKEN_MONITOR_PERIODS.map((name) => [
        name,
        {
          totalTokens: report.periods[name].totalTokens,
          costUsd: report.periods[name].costUsd,
          sessionRecords: report.periods[name].sessions.length,
        },
      ]),
    ),
    scope: "Export scope may include multiple projects and devices; periods overlap.",
    workflowBudgetsChanged: false,
  };
}

export function tokenMonitorNativeId(client: string, nativeId: string): string {
  return (client === "codex" || client === "claude") &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(nativeId)
    ? nativeId.toLowerCase()
    : nativeId;
}
