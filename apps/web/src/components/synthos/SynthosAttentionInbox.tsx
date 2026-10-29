/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Inbox, RefreshCw } from "lucide-react";
import type { SynthosWorkflow } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { synthosAttention } from "./synthosAttention";

export function SynthosAttentionInbox({
  workflows,
  threads,
  connected,
  loading,
  error,
  onRefresh,
  onSelect,
}: {
  workflows: readonly SynthosWorkflow[];
  threads: readonly EnvironmentThreadShell[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelect: (id: string, decision: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const decisions = workflows.filter((workflow) => synthosAttention(workflow) === "decision");
  const blocked = workflows.filter((workflow) => {
    const attention = synthosAttention(workflow);
    return attention === "blocked" || attention === "failed_check";
  });
  const requests = threads.filter(
    (thread) =>
      thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest,
  );
  const count = decisions.length + blocked.length + requests.length;
  const limit = expanded ? Number.POSITIVE_INFINITY : 6;
  const empty = connected && !loading && !error;

  return (
    <section className="sx-panel sx-attention" aria-label="Needs you attention inbox">
      <header className="sx-panel-title">
        <Inbox size={17} />
        <h3>Needs you</h3>
        <span>{connected ? `${count} LOADED ITEMS` : "LAST LOADED STATE"}</span>
        <button
          type="button"
          className="sx-button"
          disabled={!connected || loading}
          onClick={onRefresh}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>
      <p className="sx-panel-note">
        The latest {workflows.length} loaded missions (at most 20) and loaded, unarchived T3 thread
        summaries on this host. Open an item to inspect evidence or answer in its original thread.
        Decisions stay in the original review and permission controls.
      </p>
      {!connected && (
        <p className="sx-error" role="status">
          Host offline. These items may be stale; reconnect before acting.
        </p>
      )}
      {connected && error && (
        <p className="sx-error" role="alert">
          Mission refresh failed. The mission cards below are last-known state.
        </p>
      )}
      {loading && connected && (
        <p className="sx-muted" role="status">
          Refreshing mission attention…
        </p>
      )}
      <div className="sx-attention-grid">
        <section>
          <h4>
            Decisions <b>{decisions.length}</b>
          </h4>
          {decisions.slice(0, limit).map((workflow) => (
            <article className="sx-attention-card" key={workflow.id}>
              <span className="sx-state">Review package</span>
              <h5>{workflow.title}</h5>
              <p>Independent review is ready for a human decision.</p>
              <button
                type="button"
                disabled={!connected || Boolean(error)}
                onClick={() => onSelect(workflow.id, true)}
              >
                Open decision desk <ArrowRight size={13} />
              </button>
            </article>
          ))}
          {decisions.length === 0 && (
            <p className="sx-muted">
              {empty
                ? "No decision gates in the loaded missions."
                : "Decision coverage is not current."}
            </p>
          )}
        </section>
        <section>
          <h4>
            Blocked / checks <b>{blocked.length}</b>
          </h4>
          {blocked.slice(0, limit).map((workflow) => (
            <article className="sx-attention-card" key={workflow.id}>
              <span className="sx-state">
                {synthosAttention(workflow) === "failed_check" ? "Failed check" : "Blocked"}
              </span>
              <h5>{workflow.title}</h5>
              <p>
                {workflow.blockReason ?? `Inspect the ${workflow.stage} stage before retrying.`}
              </p>
              <button
                type="button"
                disabled={!connected || Boolean(error)}
                onClick={() => onSelect(workflow.id, false)}
              >
                Inspect workflow <ArrowRight size={13} />
              </button>
            </article>
          ))}
          {blocked.length === 0 && (
            <p className="sx-muted">
              {empty
                ? "No blocked gates in the loaded missions."
                : "Blocked-gate coverage is not current."}
            </p>
          )}
        </section>
        <section>
          <h4>
            Questions / permissions <b>{requests.length}</b>
          </h4>
          {requests.slice(0, limit).map((thread) => (
            <article className="sx-attention-card" key={thread.id}>
              <span className="sx-state">
                {thread.hasPendingApprovals
                  ? "Approval requested"
                  : thread.hasPendingUserInput
                    ? "Answer requested"
                    : "Subagent request"}
              </span>
              <h5>{thread.title || "Untitled thread"}</h5>
              <p>
                {thread.hasPendingApprovals && thread.hasPendingUserInput
                  ? "A permission and a question need your response."
                  : thread.pendingSubagentRequest
                    ? "Open the parent thread to inspect its pending requests."
                    : "Respond through T3’s original request controls."}
              </p>
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: thread.environmentId, threadId: thread.id }}
              >
                Open thread <ArrowRight size={13} />
              </Link>
            </article>
          ))}
          {requests.length === 0 && (
            <p className="sx-muted">
              {connected
                ? "No pending questions or permissions in the loaded thread summaries."
                : "Thread request coverage is not current."}
            </p>
          )}
        </section>
      </div>
      {[decisions.length, blocked.length, requests.length].some((length) => length > 6) && (
        <button
          type="button"
          className="sx-button sx-attention-expand"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show six per lane" : "Show all loaded items"}
        </button>
      )}
    </section>
  );
}
