import { SynthosSupplies } from "./SynthosSupplies";
/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  type EnvironmentId,
  type SynthosConnectionCommand,
  type SynthosConnectionStatus,
  type SynthosMailDraft,
} from "@t3tools/contracts";
import { useEnvironmentProviders } from "../../state/environments";
import { synthosRequest } from "./synthosRequest";

interface SynthosToolsProps {
  readonly environmentId: EnvironmentId | null;
  readonly statuses: readonly SynthosConnectionStatus[];
}

interface MailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly preview: string;
  readonly timestamp: string;
}

export function SynthosTools(props: SynthosToolsProps) {
  return (
    <div className="sx-tools-stack">
      <SynthosSupplies
        key={`supplies:${props.environmentId ?? "disconnected"}`}
        environmentId={props.environmentId}
      />
      <ToolsPanel key={props.environmentId ?? "disconnected"} {...props} />
    </div>
  );
}

function ToolsPanel({ environmentId, statuses }: SynthosToolsProps) {
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId ? (providersByEnvironment.get(environmentId) ?? []) : [];
  const mailStatus = statuses.find((connection) => connection.id === "agentmail");
  const mailReady = Boolean(environmentId && mailStatus?.state === "configured");
  const [inboxId, setInboxId] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<readonly MailMessage[] | null>(null);
  const [draft, setDraft] = useState<SynthosMailDraft | null>(null);
  const [outbox, setOutbox] = useState<readonly SynthosMailDraft[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  async function request<T>(command: SynthosConnectionCommand) {
    if (!environmentId) throw new Error("Connect an environment to use AgentMail.");
    return synthosRequest<T>(environmentId, "/api/synthos/connections", {
      method: "POST",
      body: command,
    });
  }

  async function run(label: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "AgentMail could not complete this request.",
      );
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  function invalidateDraft() {
    setDraft(null);
    setError(null);
  }

  return (
    <section className="sx-panel" aria-labelledby="sx-tools-title">
      <div className="sx-panel-title">
        <h2 id="sx-tools-title">Tools & communications</h2>
        <Link className="sx-button" to="/settings/providers">
          Configure providers
        </Link>
      </div>
      <p className="sx-muted">
        Provider installation, sign-in, and available models are reported by the selected host.
      </p>
      {providers.length === 0 ? (
        <p className="sx-empty">
          No provider inventory is available. Connect an environment to inspect its tools.
        </p>
      ) : (
        <div className="sx-list">
          {providers.map((provider) => (
            <details className="sx-row" key={provider.instanceId}>
              <summary>
                <strong>{provider.displayName ?? provider.driver}</strong>{" "}
                <span className="sx-state">
                  {provider.installed ? "Installed" : "Not installed"}
                </span>{" "}
                <span className="sx-muted">
                  {provider.auth.status === "authenticated"
                    ? "Signed in"
                    : provider.auth.status === "unauthenticated"
                      ? "Sign-in required"
                      : "Sign-in unknown"}
                  {" · "}
                  {provider.enabled ? "Enabled" : "Disabled"}
                </span>
              </summary>
              {provider.unavailableReason || provider.message ? (
                <p className="sx-muted">{provider.unavailableReason ?? provider.message}</p>
              ) : null}
              <p className="sx-muted">
                {provider.models.length} host-reported models
                {provider.version ? ` · Version ${provider.version}` : ""}
              </p>
              {provider.models.length > 0 ? (
                <ul>
                  {provider.models.map((model) => (
                    <li key={model.slug}>
                      {model.name}
                      <span className="sx-muted"> · {model.slug}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sx-muted">No model availability has been reported.</p>
              )}
            </details>
          ))}
        </div>
      )}

      <div className="sx-panel-title">
        <h3>AgentMail</h3>
        <span className="sx-state">{mailStatus?.state ?? "unavailable"}</span>
      </div>
      <p className="sx-muted">
        {mailStatus?.reason ??
          "Configure AgentMail on the selected host to read and prepare messages."}
      </p>
      <form
        className="sx-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run("Preparing preview", async () => {
            const prepared = await request<SynthosMailDraft>({
              type: "mail.prepare",
              inboxId: inboxId.trim(),
              to: to
                .split(",")
                .map((address) => address.trim())
                .filter(Boolean),
              subject,
              text,
            });
            setDraft(prepared);
          });
        }}
      >
        <fieldset disabled={!mailReady || busy !== null} className="sx-form">
          <label className="sx-field">
            Sender inbox
            <input
              required
              maxLength={256}
              value={inboxId}
              placeholder="Your AgentMail inbox ID"
              onChange={(event) => {
                setInboxId(event.target.value);
                setMessages(null);
                invalidateDraft();
              }}
            />
          </label>
          <div className="sx-actions">
            <button
              className="sx-button"
              type="button"
              disabled={!inboxId.trim()}
              onClick={() =>
                void run("Reading inbox", async () => {
                  const result = await request<{
                    messages: readonly MailMessage[];
                    nextPageToken: string | null;
                  }>({ type: "mail.list", inboxId: inboxId.trim(), limit: 10 });
                  setMessages(result.messages);
                })
              }
            >
              Read inbox
            </button>
            <button
              className="sx-button"
              type="button"
              onClick={() =>
                void run("Reading outbox", async () => {
                  const result = await request<{ drafts: readonly SynthosMailDraft[] }>({
                    type: "mail.outbox",
                  });
                  setOutbox(result.drafts);
                })
              }
            >
              Delivery receipts
            </button>
          </div>
          <label className="sx-field">
            To
            <input
              required
              maxLength={5120}
              value={to}
              placeholder="recipient@example.com"
              onChange={(event) => {
                setTo(event.target.value);
                invalidateDraft();
              }}
            />
            <small className="sx-muted">Separate recipients with commas.</small>
          </label>
          <label className="sx-field">
            Subject
            <input
              maxLength={998}
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                invalidateDraft();
              }}
            />
          </label>
          <label className="sx-field">
            Message
            <textarea
              required
              rows={5}
              maxLength={200000}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                invalidateDraft();
              }}
            />
          </label>
          <button className="sx-button sx-button-primary" type="submit">
            Prepare exact preview
          </button>
        </fieldset>
      </form>
      {busy && (
        <p className="sx-muted" role="status">
          {busy}…
        </p>
      )}
      {error && (
        <p className="sx-error" role="alert">
          {error}
        </p>
      )}
      {draft && (
        <section className="sx-list" aria-label="Prepared email preview">
          <h4>Review before sending</h4>
          <dl>
            <dt>Sender inbox</dt>
            <dd>{draft.envelope.inboxId}</dd>
            <dt>To</dt>
            <dd>{draft.envelope.to.join(", ")}</dd>
            <dt>Subject</dt>
            <dd>{draft.envelope.subject || "(No subject)"}</dd>
          </dl>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {draft.envelope.text}
          </pre>
          <p className="sx-muted">
            Delivery state: {draft.state}
            {draft.messageId ? ` · Message ${draft.messageId}` : ""}
          </p>
          {draft.state === "prepared" && (
            <button
              className="sx-button sx-button-primary"
              type="button"
              disabled={busy !== null || !mailReady}
              onClick={() =>
                void run("Sending approved message", async () => {
                  try {
                    setDraft(
                      await request<SynthosMailDraft>({
                        type: "mail.send",
                        id: draft.id,
                        contentHash: draft.contentHash,
                      }),
                    );
                  } catch (cause) {
                    setDraft({ ...draft, state: "unknown" });
                    throw cause;
                  }
                })
              }
            >
              Send approved message
            </button>
          )}
          {(draft.state === "pending" || draft.state === "unknown") && (
            <>
              <p className="sx-muted">
                Delivery is not confirmed. Check the receipt before preparing a replacement.
              </p>
              <button
                className="sx-button"
                type="button"
                disabled={busy !== null || !mailReady}
                onClick={() =>
                  void run("Checking delivery", async () => {
                    setDraft(
                      await request<SynthosMailDraft>({ type: "mail.reconcile", id: draft.id }),
                    );
                  })
                }
              >
                Check delivery receipt
              </button>
            </>
          )}
        </section>
      )}
      {messages && (
        <section className="sx-list" aria-label="Inbox messages">
          <h4>Inbox</h4>
          {messages.length === 0 ? (
            <p className="sx-empty">This inbox has no messages.</p>
          ) : (
            messages.map((message) => (
              <details className="sx-row" key={message.id}>
                <summary>
                  {message.subject || "(No subject)"}
                  <span className="sx-muted"> · {message.from}</span>
                </summary>
                <p className="sx-muted">{message.timestamp}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>{message.preview}</p>
              </details>
            ))
          )}
        </section>
      )}
      {outbox && (
        <section className="sx-list" aria-label="Delivery receipts">
          <h4>Delivery receipts</h4>
          {outbox.length === 0 ? (
            <p className="sx-empty">No messages have been prepared on this host.</p>
          ) : (
            outbox.map((receipt) => (
              <div className="sx-row" key={receipt.id}>
                <strong>{receipt.envelope.subject || "(No subject)"}</strong>
                <span className="sx-state">{receipt.state}</span>
                <p className="sx-muted">{receipt.envelope.to.join(", ")}</p>
                <button
                  className="sx-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setDraft(receipt)}
                >
                  Inspect exact message
                </button>
              </div>
            ))
          )}
        </section>
      )}
    </section>
  );
}
