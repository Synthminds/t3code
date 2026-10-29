/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import type { EnvironmentId, SynthosAttempt, SynthosWorkflow } from "@t3tools/contracts";
import {
  parseTokenMonitorExport,
  TOKEN_MONITOR_EXPORT_MAX_BYTES,
  TOKEN_MONITOR_PERIODS,
  type TokenMonitorExport,
  type TokenMonitorPeriodName,
} from "@t3tools/shared/tokenMonitorExport";
import * as Option from "effect/Option";
import { Gauge, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentThread } from "../../state/threads";
import { reconcileSynthosAttempt, synthosUsageLedger } from "./synthosUsage";

type UsageProps = {
  environmentId: EnvironmentId | null;
  connected: boolean;
  workflow: SynthosWorkflow | undefined;
  detailReady: boolean;
};

function count(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString();
}

function cost(value: number | null): string {
  return value === null
    ? "Unknown"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value);
}

export function SynthosUsage(props: UsageProps) {
  return <UsageStation key={`${props.environmentId}:${props.workflow?.id}`} {...props} />;
}

function UsageStation({ environmentId, connected, workflow, detailReady }: UsageProps) {
  const [report, setReport] = useState<TokenMonitorExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [period, setPeriod] = useState<TokenMonitorPeriodName>("allTime");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const importSequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fullWorkflow = detailReady ? workflow : undefined;
  const ledger = fullWorkflow ? synthosUsageLedger(fullWorkflow) : null;
  const attempt =
    fullWorkflow?.attempts.find((item) => item.id === attemptId) ?? fullWorkflow?.attempts.at(-1);

  async function importFile(file: File | undefined) {
    if (!file) return;
    const sequence = ++importSequence.current;
    setReading(true);
    setError(null);
    setReport(null);
    try {
      if (file.size > TOKEN_MONITOR_EXPORT_MAX_BYTES)
        throw new Error("Token Monitor exports must be at most 2 MiB.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const parsed = parseTokenMonitorExport(text);
      if (sequence === importSequence.current) setReport(parsed);
    } catch (cause) {
      if (sequence === importSequence.current) {
        setError(cause instanceof Error ? cause.message : "Unable to read this export.");
      }
    } finally {
      if (sequence === importSequence.current) setReading(false);
    }
  }

  return (
    <section className="sx-panel" aria-label="Usage reconciliation">
      <div className="sx-panel-title">
        <Gauge size={16} />
        <h2>Fuel telemetry · Token Monitor</h2>
      </div>
      <p className="sx-panel-note">
        Reconcile observed usage with a local Token Monitor export. GCH keeps its own reservations
        and stop limits.
      </p>
      {ledger && fullWorkflow ? (
        <>
          <dl className="sx-limits">
            <div>
              <dt>Recorded input</dt>
              <dd>{count(ledger.inputTokens)}</dd>
            </div>
            <div>
              <dt>Recorded output</dt>
              <dd>{count(ledger.outputTokens)}</dd>
            </div>
            <div>
              <dt>Still reserved</dt>
              <dd>{count(fullWorkflow.usage.reservedTokens)}</dd>
            </div>
            <div>
              <dt>Usage receipts</dt>
              <dd>
                {ledger.completeAttempts} complete · {ledger.unknownAttempts} unknown
              </dd>
            </div>
          </dl>
          <p className="sx-muted">
            {ledger.complete
              ? "All attempt receipts are complete."
              : "Coverage is incomplete. Recorded tokens are a lower bound; missing usage is not zero."}
          </p>
          {ledger.duplicateAttempts > 0 && (
            <p className="sx-error">
              {ledger.duplicateAttempts} duplicate attempt or thread identities excluded. Inspect
              the mission before reconciling.
            </p>
          )}
        </>
      ) : (
        <p className="sx-muted">
          {workflow
            ? "Load the complete mission detail to inspect its usage receipts."
            : "Select a mission to compare its native usage receipts."}
        </p>
      )}
      <div className="sx-form">
        <label className="sx-field">
          Token Monitor JSON export
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            disabled={reading}
            onChange={(event) => {
              void importFile(event.currentTarget.files?.[0]);
            }}
          />
        </label>
        <p className="sx-muted">
          In Token Monitor: Settings → Collection → Data export → Export data. Import
          token-monitor-export.json (2 MiB max). It stays in this panel until cleared or you switch
          mission or environment.
        </p>
        {reading && (
          <p role="status">
            <Upload size={14} /> Reading local export…
          </p>
        )}
        {error && (
          <p className="sx-error" role="alert">
            {error}
          </p>
        )}
        {report && (
          <>
            <p className="sx-muted">
              Token Monitor {report.version} · exported{" "}
              {new Date(report.generatedAt).toLocaleString()}
            </p>
            <label className="sx-field">
              Export period
              <select
                value={period}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (TOKEN_MONITOR_PERIODS.some((name) => name === value))
                    setPeriod(value as TokenMonitorPeriodName);
                }}
              >
                <option value="allTime">All time</option>
                <option value="month">Month</option>
                <option value="today">Today</option>
              </select>
            </label>
            <dl className="sx-limits">
              <div>
                <dt>Exported tokens</dt>
                <dd>{count(report.periods[period].totalTokens)}</dd>
              </div>
              <div>
                <dt>Reported cost</dt>
                <dd>{cost(report.periods[period].costUsd)}</dd>
              </div>
              <div>
                <dt>Session records</dt>
                <dd>{report.periods[period].sessions.length}</dd>
              </div>
            </dl>
            <p className="sx-muted">
              Export totals may include other projects and devices. Periods overlap. They are never
              added to mission totals or used to release reservations.
            </p>
            {fullWorkflow && attempt && ledger?.duplicateAttempts === 0 && (
              <>
                <label className="sx-field">
                  Match a mission attempt
                  <select
                    value={attempt.id}
                    onChange={(event) => setAttemptId(event.currentTarget.value)}
                  >
                    {fullWorkflow.attempts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.role} · {item.stage} · {item.id}
                      </option>
                    ))}
                  </select>
                </label>
                <AttemptComparison
                  key={`${environmentId}:${attempt.id}`}
                  environmentId={environmentId}
                  connected={connected}
                  attempt={attempt}
                  report={report}
                  workflowUpdatedAt={fullWorkflow.updatedAt}
                />
              </>
            )}
            <button
              className="sx-button"
              type="button"
              onClick={() => {
                importSequence.current += 1;
                setReport(null);
                setError(null);
                setReading(false);
                if (inputRef.current) inputRef.current.value = "";
              }}
            >
              Clear imported export
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function AttemptComparison({
  environmentId,
  connected,
  attempt,
  report,
  workflowUpdatedAt,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
  attempt: SynthosAttempt;
  report: TokenMonitorExport;
  workflowUpdatedAt: number;
}) {
  const thread = useEnvironmentThread(
    connected ? environmentId : null,
    connected ? attempt.threadId : null,
  );
  const projection = Option.getOrNull(thread.data);
  if (
    !connected ||
    thread.status !== "live" ||
    projection === null ||
    Option.isSome(thread.error) ||
    thread.history.hasMoreHistory ||
    thread.history.error !== null
  ) {
    return (
      <p className="sx-muted">
        Native session comparison needs a connected environment and complete thread history.
        Imported totals remain available.
      </p>
    );
  }
  const result = reconcileSynthosAttempt(attempt, projection, report, workflowUpdatedAt);
  if (result.kind !== "matched") return <p className="sx-muted">{result.reason}</p>;
  return (
    <div className="sx-form">
      <p>
        Exact native identity: {result.tool} · <code>{result.nativeId}</code>
      </p>
      <dl className="sx-limits">
        <div>
          <dt>Attempt input + output</dt>
          <dd>{count(result.recordedTokens)}</dd>
        </div>
        <div>
          <dt>Exported session · all time</dt>
          <dd>{count(result.exportTokens)}</dd>
        </div>
        <div>
          <dt>Session reported cost</dt>
          <dd>{cost(result.exportCostUsd)}</dd>
        </div>
        <div>
          <dt>Reported token difference</dt>
          <dd>{count(result.difference)}</dd>
        </div>
      </dl>
      <p className="sx-muted">
        {result.reason} Parent and subagent totals are never combined here.
      </p>
    </div>
  );
}
