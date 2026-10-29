/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useRef, useState } from "react";
import { BookOpen, FileCheck2, Save } from "lucide-react";
import type { EnvironmentId, SynthosConnectionStatus, SynthosWorkflow } from "@t3tools/contracts";
import { synthosRequest } from "./synthosRequest";

type Props = {
  environmentId: EnvironmentId | null;
  connected: boolean;
  workflow: SynthosWorkflow | null;
};
type VaultNote = { path: string; content: string; version: string };
type Capture = { sourceKey: string; provenance: string };

function sourceKey(environmentId: EnvironmentId, workflow: SynthosWorkflow) {
  return JSON.stringify([environmentId, workflow.id, workflow.revision, workflow.policyHash]);
}

function provenance(environmentId: EnvironmentId, workflow: SynthosWorkflow) {
  const candidate = workflow.attempts.findLast((attempt) => attempt.candidateRef !== null);
  const capturedAt = new Date().toISOString();
  const value = (entry: unknown) => JSON.stringify(entry);
  return [
    "---",
    "schema: synthos.gch-memory.v1",
    "type: mission-memory",
    `date: ${capturedAt.slice(0, 10)}`,
    "tags: [gch, synthos, reviewed-memory]",
    "ai-first: true",
    "source: synthos-gch",
    "capture_mode: human-reviewed",
    `title: ${value(workflow.title)}`,
    `environment_id: ${value(environmentId)}`,
    `workflow_id: ${value(workflow.id)}`,
    `workflow_revision: ${workflow.revision}`,
    `workflow_status_as_of_capture: ${value(workflow.status)}`,
    `source_snapshot_at: ${value(capturedAt)}`,
    `policy_version: ${value(workflow.policyVersion)}`,
    `policy_hash: ${value(workflow.policyHash)}`,
    `candidate_ref: ${value(workflow.publication.candidateRef ?? candidate?.candidateRef ?? null)}`,
    `candidate_source: ${workflow.publication.candidateRef ? "publication-package" : candidate ? "recorded-attempt" : "unavailable"}`,
    `publication_status_as_of_capture: ${value(workflow.publication.status)}`,
    `decision_as_of_capture: ${value(workflow.decision?.action ?? null)}`,
    `decision_evidence_hash: ${value(workflow.decision?.evidenceHash ?? null)}`,
    `source_threads: ${value(
      workflow.attempts.map((attempt) => ({
        thread_id: attempt.threadId,
        role: attempt.role,
        packet_hash: attempt.packetHash,
        evidence_hash: attempt.evidenceHash,
      })),
    )}`,
    "---",
  ].join("\n");
}

export function SynthosMemoryCapture(props: Props) {
  return <MemoryCaptureForm key={props.environmentId ?? "disconnected"} {...props} />;
}

function MemoryCaptureForm({ environmentId, connected, workflow }: Props) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [path, setPath] = useState("");
  const [body, setBody] = useState("");
  const [existing, setExisting] = useState<VaultNote | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ path: string; version: string } | null>(null);
  const inFlight = useRef(false);
  const available =
    connected && environmentId !== null && workflow !== null && !workflow.detailOmitted;
  const current = available && capture?.sourceKey === sourceKey(environmentId, workflow);
  const content = capture
    ? `${capture.provenance}\n\n## For future agent\n\nThis reviewed memory comes from a GCH mission. Consult the pinned workflow, policy, and source thread references before relying on its dated status.\n\n## Reviewed memory\n\n${body.trim()}\n`
    : "";
  const validPath =
    path.length <= 256 &&
    path.endsWith(".md") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
  const withinLimit = new TextEncoder().encode(content).byteLength <= 64 * 1024;

  function clearReview() {
    setPreview(null);
    setReviewed(false);
    setReceipt(null);
  }

  async function startCapture() {
    if (!available || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await synthosRequest<{ connections: readonly SynthosConnectionStatus[] }>(
        environmentId,
        "/api/synthos/connections",
        { method: "POST", body: { type: "status" } },
      );
      const status = result.connections.find((connection) => connection.id === "obsidian");
      if (status?.state !== "configured") {
        throw new Error(status?.reason ?? "Configure the Obsidian vault on this host first.");
      }
      setCapture({
        sourceKey: sourceKey(environmentId, workflow),
        provenance: provenance(environmentId, workflow),
      });
      const slug = workflow.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "mission";
      setPath(`GCH/Missions/${slug}-r${workflow.revision}.md`);
      setBody("");
      setExisting(null);
      clearReview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The vault status could not be read.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function readDestination() {
    if (!environmentId || !current || !validPath || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    clearReview();
    try {
      const note = await synthosRequest<VaultNote>(environmentId, "/api/synthos/connections", {
        method: "POST",
        body: { type: "obsidian.read", path },
      });
      setExisting(note);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The destination could not be read.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (
      !environmentId ||
      !current ||
      !validPath ||
      !withinLimit ||
      !reviewed ||
      preview !== content ||
      !body.trim() ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setReviewed(false);
    try {
      const note = await synthosRequest<VaultNote>(environmentId, "/api/synthos/connections", {
        method: "POST",
        body: {
          type: "obsidian.write",
          path,
          content: preview,
          expectedVersion: existing?.path === path ? existing.version : null,
        },
      });
      setExisting(note);
      setReceipt({ path: note.path, version: note.version });
      setPreview(null);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "Save was not confirmed."} Read the destination before retrying; your draft is retained.`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="sx-panel sx-memory-capture" aria-labelledby="sx-memory-title">
      <header className="sx-panel-title">
        <BookOpen size={17} />
        <h3 id="sx-memory-title">Memory cassette</h3>
      </header>
      <div className="sx-form sx-memory-body">
        <p>
          Keep a reviewed decision or lesson in Obsidian, with its GCH policy and source thread
          references.
        </p>
        {!available && (
          <p className="sx-notice">
            Connect a host and load a complete mission revision to capture a note.
          </p>
        )}
        <button
          type="button"
          className="sx-button"
          onClick={() => void startCapture()}
          disabled={!available || busy}
        >
          <FileCheck2 size={15} />{" "}
          {capture ? "Discard draft and start current revision" : "Prepare memory capture"}
        </button>
        {capture && (
          <>
            {!current && (
              <p className="sx-notice">
                The mission or connection changed. Start a capture from its current revision before
                saving.
              </p>
            )}
            <label className="sx-field">
              <span>Note path inside the configured vault</span>
              <input
                value={path}
                disabled={busy}
                maxLength={256}
                onChange={(event) => {
                  setPath(event.target.value);
                  setExisting(null);
                  clearReview();
                }}
              />
            </label>
            <label className="sx-field">
              <span>Decision or lesson to remember</span>
              <textarea
                rows={7}
                maxLength={20000}
                value={body}
                disabled={busy}
                placeholder="Write the decision, supporting evidence, and when to revisit it. Markdown is supported."
                onChange={(event) => {
                  setBody(event.target.value);
                  clearReview();
                }}
              />
            </label>
            <p>
              Only this note and the displayed source metadata are saved. Mission status is dated;
              saving a memory does not approve or publish the mission.
            </p>
            <button
              type="button"
              className="sx-button"
              disabled={!current || !validPath || busy}
              onClick={() => void readDestination()}
            >
              Read destination before updating
            </button>
            {existing && (
              <details>
                <summary>Existing note: saving will replace this loaded version</summary>
                <pre className="sx-memory-preview">{existing.content}</pre>
              </details>
            )}
            {!validPath && (
              <p className="sx-error">
                Use a relative .md path without hidden folders, parent segments, or backslashes.
              </p>
            )}
            {!withinLimit && (
              <p className="sx-error">
                The note and source references exceed 64 KiB. Shorten the note before previewing.
              </p>
            )}
            <button
              type="button"
              className="sx-button"
              disabled={!current || !validPath || !body.trim() || !withinLimit || busy}
              onClick={() => {
                setPreview(content);
                setReviewed(false);
                setError(null);
                setReceipt(null);
              }}
            >
              Preview exact note
            </button>
            {preview && (
              <>
                <pre className="sx-memory-preview" aria-label="Exact Markdown to save">
                  {preview}
                </pre>
                <label className="sx-memory-review">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={!current || busy}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  {existing
                    ? "I reviewed this note and the existing version it will replace."
                    : "I reviewed this note and its destination."}
                </label>
                <button
                  type="button"
                  className="sx-button sx-button-primary"
                  disabled={!current || !reviewed || busy}
                  onClick={() => void save()}
                >
                  <Save size={15} /> {busy ? "Saving…" : "Save reviewed memory"}
                </button>
              </>
            )}
          </>
        )}
        {error && (
          <p className="sx-error" role="alert">
            {error}
          </p>
        )}
        {receipt && (
          <p className="sx-notice" role="status">
            Saved {receipt.path}. Version receipt: <code>{receipt.version}</code>
          </p>
        )}
      </div>
    </section>
  );
}
