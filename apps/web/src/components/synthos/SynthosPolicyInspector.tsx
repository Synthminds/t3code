/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import type { EnvironmentId, SynthosPolicy, SynthosWorkflow } from "@t3tools/contracts";
import { synthosRequest } from "./synthosRequest";

export function SynthosPolicyInspector({
  environmentId,
  connected,
  workflow,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
  workflow: SynthosWorkflow | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    policy?: SynthosPolicy;
    error?: string;
  } | null>(null);
  const key = `${environmentId}:${attempt}`;
  const policy = connected && result?.key === key ? result.policy : undefined;
  const error = connected && result?.key === key ? result.error : undefined;
  const loading = connected && environmentId !== null && !policy && !error;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- inspect the selected host's policy over authenticated HTTP and discard superseded responses
  useEffect(() => {
    if (!connected || !environmentId) return;
    const controller = new AbortController();
    void synthosRequest<SynthosPolicy>(environmentId, "/api/synthos/policy", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setResult({ key, policy: value });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            error: cause instanceof Error ? cause.message : "The host policy could not be read.",
          });
      });
    return () => controller.abort();
  }, [environmentId, connected, key]);

  const repository =
    policy && URL.canParse(policy.sourceRepository) ? new URL(policy.sourceRepository) : null;
  const sourceBase =
    policy && repository?.protocol === "https:"
      ? `${repository.href.replace(/\/$/, "")}/blob/${encodeURIComponent(policy.sourceCommit)}`
      : null;
  const matches = policy && workflow?.policyHash === policy.sha256;
  const mismatch = Boolean(policy && workflow && !matches);

  return (
    <details className="sx-panel sx-policy-inspector">
      <summary className="sx-policy-summary">
        <ShieldCheck size={18} aria-hidden="true" />
        <span>
          <strong>GCH operating core</strong>
          <small>Mission rules, provenance, and enforcement</small>
        </span>
        <span className="sx-policy-version" role="status" data-mismatch={mismatch}>
          {!connected
            ? "HOST OFFLINE"
            : loading
              ? "LOADING…"
              : mismatch
                ? "POLICY MISMATCH"
                : (policy?.version ?? "UNAVAILABLE")}
        </span>
        <ChevronRight size={17} className="sx-policy-chevron" aria-hidden="true" />
      </summary>
      <div className="sx-policy-body" aria-busy={loading}>
        <p>
          GCH governs SynthOS mission roles, task packets, budgets, verification, and decisions. T3
          supplies the provider sessions, editor, and terminal. Ordinary T3 chats do not
          automatically receive this mission policy.
        </p>
        {!connected || !environmentId ? (
          <p className="sx-muted">Connect an environment to inspect its GCH policy.</p>
        ) : loading ? (
          <p className="sx-muted" role="status">
            Reading the selected host’s policy…
          </p>
        ) : error ? (
          <div className="sx-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw size={14} /> Retry policy
            </button>
          </div>
        ) : policy ? (
          <>
            <div className="sx-policy-binding" data-mismatch={mismatch}>
              <strong>
                {!workflow
                  ? "Current host policy · no mission selected"
                  : matches
                    ? "Selected mission matches the current host policy"
                    : "Selected mission uses a different policy"}
              </strong>
              {workflow && !matches && (
                <p role="alert">
                  These rules describe this host’s current policy, not the selected mission’s
                  original snapshot. Its pinned version is {workflow.policyVersion}.
                </p>
              )}
              {workflow && (
                <p>
                  Mission fingerprint <code>{workflow.policyHash}</code>
                </p>
              )}
            </div>
            <dl className="sx-policy-metadata">
              <div>
                <dt>Host policy</dt>
                <dd>{policy.version}</dd>
              </div>
              <div>
                <dt>Policy fingerprint</dt>
                <dd>
                  <code>{policy.sha256}</code>
                </dd>
              </div>
              <div>
                <dt>Source capture</dt>
                <dd>{policy.capturedAt}</dd>
              </div>
              <div>
                <dt>Source commit</dt>
                <dd>
                  {sourceBase ? (
                    <a
                      href={sourceBase.replace("/blob/", "/tree/")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <code>{policy.sourceCommit}</code>
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ) : (
                    <code>{policy.sourceCommit}</code>
                  )}
                </dd>
              </div>
              <div>
                <dt>Rules fingerprint</dt>
                <dd>
                  <code>{policy.canonicalRulesSha256}</code>
                </dd>
              </div>
            </dl>
            <p className="sx-muted">
              This is a pinned source capture, not a live Google Drive sync. Earlier editions remain
              traceable through the source manifest.
            </p>
            <div className="sx-policy-controls">
              <section>
                <h3>Enforced by this runtime</h3>
                <ul>
                  {policy.enforced.map((control) => (
                    <li key={control}>{control}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>Limits to account for</h3>
                <ul>
                  {policy.limitations.map((limit) => (
                    <li key={limit}>{limit}</li>
                  ))}
                </ul>
              </section>
            </div>
            <p className="sx-muted">
              Construction agents currently edit directly. Freezing pre-existing tests before
              construction and restricting patch application to the lead remain to be implemented.
            </p>
            <details className="sx-policy-document">
              <summary>Read the injected GCH rules</summary>
              <pre tabIndex={0} aria-label="Canonical GCH rules">
                <code>{policy.canonicalRules}</code>
              </pre>
            </details>
            <details className="sx-policy-document">
              <summary>Preserved sources · {policy.sources.length} files</summary>
              <ul className="sx-policy-sources" tabIndex={0} aria-label="GCH source manifest">
                {policy.sources.map((source) => (
                  <li key={source.path}>
                    {sourceBase ? (
                      <a
                        href={`${sourceBase}/${source.path.split("/").map(encodeURIComponent).join("/")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {source.path}
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    ) : (
                      <span>{source.path}</span>
                    )}
                    <code>{source.sha256}</code>
                  </li>
                ))}
              </ul>
            </details>
            <button
              type="button"
              className="sx-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RefreshCw size={14} /> Refresh host policy
            </button>
          </>
        ) : null}
      </div>
    </details>
  );
}
