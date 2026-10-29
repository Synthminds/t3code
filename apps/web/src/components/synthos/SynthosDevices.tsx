import { randomUUID } from "../../lib/utils";
/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useRef, useState } from "react";
import {
  type EnvironmentId,
  type SynthosConnectionCommand,
  type SynthosConnectionStatus,
  type SynthosDeviceProposal,
} from "@t3tools/contracts";
import { synthosRequest } from "./synthosRequest";

interface SynthosDevicesProps {
  readonly environmentId: EnvironmentId | null;
  readonly statuses: readonly SynthosConnectionStatus[];
}

const DEVICE_SOURCES = [
  { id: "harness", label: "Harness" },
  { id: "fieldy", label: "Fieldy" },
  { id: "g2", label: "Even G2" },
] as const;

export function SynthosDevices(props: SynthosDevicesProps) {
  return <DevicesPanel key={props.environmentId ?? "disconnected"} {...props} />;
}

function DevicesPanel({ environmentId, statuses }: SynthosDevicesProps) {
  const [source, setSource] = useState<"harness" | "fieldy" | "g2">("harness");
  const [sourceId, setSourceId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [proposals, setProposals] = useState<readonly SynthosDeviceProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(environmentId));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);

  async function request<T>(command: SynthosConnectionCommand, signal?: AbortSignal) {
    if (!environmentId) throw new Error("Connect an environment to save a capture for review.");
    return synthosRequest<T>(environmentId, "/api/synthos/connections", {
      method: "POST",
      body: command,
      ...(signal ? { signal } : {}),
    });
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load persisted device proposals from the selected host and cancel when the panel unmounts.
  useEffect(() => {
    if (!environmentId) return;
    const controller = new AbortController();
    void synthosRequest<{ proposals: readonly SynthosDeviceProposal[] }>(
      environmentId,
      "/api/synthos/connections",
      {
        method: "POST",
        body: { type: "device.list" },
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (!controller.signal.aborted) setProposals(result.proposals);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Device captures could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [environmentId]);

  return (
    <section className="sx-panel" aria-labelledby="sx-devices-title">
      <div className="sx-panel-title">
        <h2 id="sx-devices-title">Device intake</h2>
        <span className="sx-state">Review first</span>
      </div>
      <div className="sx-list">
        {DEVICE_SOURCES.map((device) => {
          const status = statuses.find((connection) => connection.id === device.id);
          return (
            <div className="sx-row" key={device.id}>
              <strong>{device.label}</strong>
              <span className="sx-state">{status?.state ?? "unavailable"}</span>
              <p className="sx-muted">
                {status?.reason ?? "Device connection is not configured on this host."}
              </p>
            </div>
          );
        })}
      </div>
      <div className="sx-panel-title">
        <h3>Manual capture</h3>
      </div>
      <p className="sx-muted">
        Paste a device capture into the review inbox. Captures stay proposals until you choose what
        to do with them.
      </p>
      <form
        className="sx-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError(null);
          setNotice(null);
          const captureSourceId = sourceId.trim() || randomUUID();
          setSourceId(captureSourceId);
          void request<{ proposal: SynthosDeviceProposal; duplicate: boolean }>({
            type: "device.intake",
            source,
            sourceId: captureSourceId,
            title: title.trim(),
            content,
            capturedAt: new Date().toISOString(),
          })
            .then((result) => {
              setProposals((current) => [
                result.proposal,
                ...current.filter((proposal) => proposal.id !== result.proposal.id),
              ]);
              setNotice(
                result.duplicate
                  ? "This capture is already in the review inbox."
                  : "Capture saved for review.",
              );
              setTitle("");
              setContent("");
              setSourceId("");
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error ? cause.message : "The device capture could not be saved.",
              );
            })
            .finally(() => {
              pending.current = false;
              setBusy(false);
            });
        }}
      >
        <fieldset className="sx-form" disabled={!environmentId || busy}>
          <div className="sx-split">
            <label className="sx-field">
              Source
              <select
                value={source}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "harness" || value === "fieldy" || value === "g2") setSource(value);
                }}
              >
                {DEVICE_SOURCES.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sx-field">
              Capture reference (optional)
              <input
                maxLength={256}
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                placeholder="Original recording or capture ID"
              />
            </label>
          </div>
          <label className="sx-field">
            Title
            <input
              required
              maxLength={256}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="sx-field">
            Capture text
            <textarea
              required
              rows={6}
              maxLength={12000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <button type="submit" className="sx-button sx-button-primary">
            {busy ? "Saving capture…" : "Save for review"}
          </button>
        </fieldset>
      </form>
      {!environmentId && (
        <p className="sx-empty">Connect an environment to save and inspect device captures.</p>
      )}
      {error && (
        <p className="sx-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="sx-muted" role="status">
          {notice}
        </p>
      )}
      <div className="sx-panel-title">
        <h3>Review inbox</h3>
        <button
          className="sx-button"
          type="button"
          disabled={!environmentId || busy || loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            void request<{ proposals: readonly SynthosDeviceProposal[] }>({ type: "device.list" })
              .then((result) => setProposals(result.proposals))
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "The review inbox could not be refreshed.",
                ),
              )
              .finally(() => setLoading(false));
          }}
        >
          {loading ? "Loading…" : "Refresh captures"}
        </button>
      </div>
      {proposals.length === 0 ? (
        <p className="sx-empty">
          {loading ? "Loading saved captures…" : "No captures are waiting for review."}
        </p>
      ) : (
        <div className="sx-list">
          {proposals.map((proposal) => (
            <details className="sx-row" key={proposal.id}>
              <summary>
                <strong>{proposal.title}</strong>
                <span className="sx-state">{proposal.status}</span>
              </summary>
              <p className="sx-muted">
                {DEVICE_SOURCES.find((device) => device.id === proposal.source)?.label ??
                  proposal.source}{" "}
                · {proposal.capturedAt}
              </p>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{proposal.body}</p>
              <p className="sx-muted">External input · Review only</p>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
