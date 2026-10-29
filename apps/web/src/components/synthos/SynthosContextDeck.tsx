/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useRef, useState } from "react";
import {
  CassetteTape,
  FileText,
  FolderSearch,
  Pin,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import type {
  EnvironmentId,
  ProjectId,
  SynthosContextManifest,
  SynthosContextResult,
  SynthosContextSettings,
  SynthosContextSettingsInput,
  SynthosRole,
  SynthosWorkflow,
} from "@t3tools/contracts";
import { SynthosRole as RoleSchema } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { synthosRequest } from "./synthosRequest";

const emptySettings: SynthosContextSettingsInput = {
  autoRecall: false,
  approvedNotes: [],
  projectFolders: [],
  neighborhoodFolders: [],
  pinnedNotes: [],
  excludedPaths: [],
};
const fields = [
  ["approvedNotes", "Approved notes", "Vault-relative Markdown paths, one per line."],
  ["projectFolders", "Project folders · tier 1", "Reviewed project material to search first."],
  [
    "neighborhoodFolders",
    "Vault neighborhoods · tier 2",
    "Search these folders when project matches are sparse.",
  ],
  ["pinnedNotes", "Pinned notes", "Include these notes for future attempts."],
  ["excludedPaths", "Excluded paths", "Notes or folders to leave out of recall."],
] as const;
const lines = (text: string) => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Context could not be loaded. Try again.";

export function SynthosContextDeck({
  environmentId,
  connected,
  workflow,
  loading,
  role,
  onRoleChange,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
  workflow: SynthosWorkflow | undefined;
  loading: boolean;
  role: SynthosRole;
  onRoleChange: (role: SynthosRole) => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectChoice, setProjectChoice] = useState("");
  const project =
    projects.find((item) => item.id === (workflow?.projectId ?? projectChoice)) ?? projects[0];
  return (
    <div className="sx-context-deck">
      {!workflow && (
        <label className="sx-field">
          Project
          <select
            value={project?.id ?? ""}
            onChange={(event) => setProjectChoice(event.target.value)}
          >
            {!projects.length && <option value="">No projects on this host</option>}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {loading ? (
        <p role="status" className="sx-muted">
          Loading the complete mission context…
        </p>
      ) : project && environmentId ? (
        <ContextProject
          key={`${environmentId}:${project.id}`}
          environmentId={environmentId}
          projectId={project.id}
          connected={connected}
          workflow={workflow}
          role={role}
          onRoleChange={onRoleChange}
        />
      ) : (
        <p className="sx-empty">
          Create a project in the workspace to configure its context and memory neighborhoods.
        </p>
      )}
    </div>
  );
}

function ContextProject({
  environmentId,
  projectId,
  connected,
  workflow,
  role,
  onRoleChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connected: boolean;
  workflow: SynthosWorkflow | undefined;
  role: SynthosRole;
  onRoleChange: (role: SynthosRole) => void;
}) {
  const [settings, setSettings] = useState<SynthosContextSettings | null>(null);
  const [draft, setDraft] = useState<SynthosContextSettingsInput>(emptySettings);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; manifest: SynthosContextManifest } | null>(
    null,
  );
  const pending = useRef(false);
  const loadedRefresh = useRef(-1);
  const currentRequest = useRef(0);
  const attempts = workflow?.attempts.filter((attempt) => attempt.role === role) ?? [];
  const selectedAttempt = attempts.find((attempt) => attempt.id === selection) ?? attempts.at(-1);
  const taskText = workflow?.task ?? task;
  const previewKey = `${projectId}:${workflow?.revision ?? 0}:${role}:${taskText}:${settings?.version ?? 0}`;
  const currentPreview = preview?.key === previewKey ? preview.manifest : null;
  const showingPreview = selection === "preview";
  const manifest = showingPreview ? currentPreview : selectedAttempt?.contextManifest;
  const settingsLoading = loaded !== refresh;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read host-owned project settings and cancel superseded loads
  useEffect(() => {
    if (!connected || loadedRefresh.current === refresh) return;
    const controller = new AbortController();
    void synthosRequest<SynthosContextResult>(environmentId, "/api/synthos/context", {
      method: "POST",
      body: { type: "get_settings", projectId },
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.type !== "settings")
          throw new Error("The host did not return context settings.");
        loadedRefresh.current = refresh;
        setSettings(result.settings);
        setDraft(result.settings);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(refresh);
      });
    return () => controller.abort();
  }, [environmentId, projectId, connected, refresh]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidate in-flight preview and save responses when this project view unmounts
  useEffect(() => {
    return () => {
      currentRequest.current += 1;
      pending.current = false;
    };
  }, []);

  async function run(action: "preview" | "save") {
    if (!connected || pending.current || settingsLoading || !settings) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const requestId = ++currentRequest.current;
    try {
      const result = await synthosRequest<SynthosContextResult>(
        environmentId,
        "/api/synthos/context",
        {
          method: "POST",
          body:
            action === "preview"
              ? {
                  type: "preview",
                  projectId,
                  role,
                  task: taskText,
                  ...(workflow ? { workflowId: workflow.id } : {}),
                }
              : {
                  type: "save_settings",
                  projectId,
                  expectedVersion: settings.version,
                  settings: {
                    autoRecall: draft.autoRecall,
                    approvedNotes: draft.approvedNotes,
                    projectFolders: draft.projectFolders,
                    neighborhoodFolders: draft.neighborhoodFolders,
                    pinnedNotes: draft.pinnedNotes,
                    excludedPaths: draft.excludedPaths,
                  },
                },
        },
      );
      if (currentRequest.current !== requestId) return;
      if (result.type === "preview") {
        setPreview({ key: previewKey, manifest: result.manifest });
        setSelection("preview");
      } else {
        setSettings(result.settings);
        setDraft(result.settings);
        setNotice("Saved for future attempts. Refresh the preview to inspect the new selection.");
      }
    } catch (cause) {
      if (currentRequest.current === requestId)
        setError(
          `${messageOf(cause)} Your draft is retained; reload saved settings if another session changed them.`,
        );
    } finally {
      if (currentRequest.current === requestId) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  function markPath(path: string, field: "pinnedNotes" | "excludedPaths") {
    setDraft((value) => ({
      ...value,
      [field]: [...new Set([...value[field], path])],
      ...(field === "pinnedNotes"
        ? { excludedPaths: value.excludedPaths.filter((item) => item !== path) }
        : { pinnedNotes: value.pinnedNotes.filter((item) => item !== path) }),
    }));
    setSettingsOpen(true);
    setNotice("Context settings changed below. Save to apply this to future attempts.");
  }

  return (
    <>
      <section className="sx-panel sx-context-player" aria-label="Agent context">
        <header className="sx-panel-title">
          <CassetteTape size={18} />
          <h3>Agent cassette</h3>
          <span>{showingPreview ? "PREVIEW" : "FROZEN RECORD"}</span>
        </header>
        <div className="sx-context-body">
          <div className="sx-context-controls">
            <label className="sx-field">
              Agent role
              <select
                value={role}
                onChange={(event) => {
                  onRoleChange(event.target.value as SynthosRole);
                  setSelection(null);
                }}
              >
                {RoleSchema.literals.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="sx-field">
              Attempt history
              <select
                value={showingPreview ? "preview" : (selectedAttempt?.id ?? "")}
                onChange={(event) => setSelection(event.target.value)}
              >
                {!attempts.length && <option value="">No dispatched attempts</option>}
                {attempts.toReversed().map((attempt) => (
                  <option key={attempt.id} value={attempt.id}>
                    {attempt.stage} · loop {attempt.loop} · {attempt.status} ·{" "}
                    {attempt.id.slice(-8)}
                  </option>
                ))}
                <option value="preview">Current-source preview</option>
              </select>
            </label>
            <button
              type="button"
              className="sx-button"
              disabled={!connected || busy || settingsLoading || !settings || !taskText.trim()}
              onClick={() => void run("preview")}
            >
              <RefreshCw size={15} />
              {busy && showingPreview ? "Reading sources…" : "Refresh preview"}
            </button>
          </div>
          {!workflow && (
            <label className="sx-field">
              Task to preview
              <textarea
                rows={3}
                value={task}
                onChange={(event) => setTask(event.target.value)}
                placeholder="Describe the work to find relevant guidance and memories."
              />
            </label>
          )}
          {!connected && (
            <p className="sx-muted" role="status">
              Host offline. Displayed snapshots are historical; reconnect to refresh or save.
            </p>
          )}
          {busy && (
            <p className="sx-muted" role="status">
              Reading or saving context on this host…
            </p>
          )}
          {error && (
            <p className="sx-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="sx-context-notice" role="status">
              {notice}
            </p>
          )}
          {manifest ? (
            <ManifestView
              manifest={manifest}
              preview={showingPreview}
              currentPreview={currentPreview}
              canEdit={connected && !busy && !settingsLoading}
              onMark={markPath}
            />
          ) : (
            <p className="sx-empty">
              {showingPreview
                ? "Refresh the preview to see what this role would receive from the current sources and saved settings."
                : selectedAttempt
                  ? "Context manifest unavailable for this historical attempt. Its original packet and T3 evidence remain available."
                  : "This role has not been dispatched. Preview its context before starting the mission."}
            </p>
          )}
          {workflow && (
            <details className="sx-context-section">
              <summary>
                <ShieldCheck size={15} />
                Mission brief and operating core
              </summary>
              <p className="sx-context-prose">{workflow.task}</p>
              <p>Full GCH operating rules accompany every managed attempt.</p>
              <dl className="sx-context-metadata">
                <dt>Policy</dt>
                <dd>{workflow.policyVersion}</dd>
                <dt>Fingerprint</dt>
                <dd>
                  <code>{workflow.policyHash}</code>
                </dd>
              </dl>
            </details>
          )}
          {selectedAttempt && !showingPreview && (
            <details className="sx-context-section">
              <summary>
                <FileText size={15} />
                Frozen task and handoff
              </summary>
              {Array.from(
                new DOMParser()
                  .parseFromString(selectedAttempt.packetHtml, "text/html")
                  .querySelectorAll("section"),
              ).map((section) => (
                <div
                  className="sx-context-packet-section"
                  key={section.getAttribute("data-section") ?? section.textContent}
                >
                  <h4>{section.querySelector("h2")?.textContent ?? "Context"}</h4>
                  <pre>{section.querySelector("pre")?.textContent ?? section.textContent}</pre>
                </div>
              ))}
              {!selectedAttempt.packetHtml && (
                <p className="sx-muted">The complete packet is not loaded.</p>
              )}
            </details>
          )}
        </div>
      </section>
      <details
        className="sx-panel sx-context-settings"
        open={settingsOpen}
        onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
      >
        <summary className="sx-policy-summary">
          <FolderSearch size={18} />
          <span>
            <strong>Project memory neighborhoods</strong>
            <small>Project first. Nearby knowledge when needed.</small>
          </span>
          <span className="sx-policy-version">
            {settings?.autoRecall ? "RECALL ON" : "RECALL OFF"}
          </span>
        </summary>
        <form
          className="sx-context-body"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save");
          }}
        >
          <p className="sx-muted">
            Paths belong to this host’s configured Obsidian vault. Tier 2 runs only when tier 1 has
            fewer than three qualifying matches. Saved changes affect future attempts.
          </p>
          {settingsLoading && connected && <p role="status">Loading saved context settings…</p>}
          <label className="sx-context-toggle">
            <input
              type="checkbox"
              checked={draft.autoRecall}
              disabled={!connected || busy || settingsLoading}
              onChange={(event) => setDraft({ ...draft, autoRecall: event.target.checked })}
            />
            Automatically recall project memories
          </label>
          <div className="sx-context-settings-grid">
            {fields.map(([field, label, hint]) => (
              <label className="sx-field" key={field}>
                {label}
                <textarea
                  rows={3}
                  value={draft[field].join("\n")}
                  disabled={!connected || busy || settingsLoading}
                  onChange={(event) =>
                    setDraft({ ...draft, [field]: event.target.value.split("\n") })
                  }
                  onBlur={() =>
                    setDraft((value) => ({ ...value, [field]: lines(value[field].join("\n")) }))
                  }
                />
                <small>{hint}</small>
              </label>
            ))}
          </div>
          <div className="sx-actions">
            <button
              className="sx-button sx-button-primary"
              type="submit"
              disabled={!connected || busy || settingsLoading || !settings}
            >
              <Save size={15} />
              Save context settings
            </button>
            <button
              className="sx-button"
              type="button"
              disabled={!connected || busy}
              onClick={() => {
                setNotice("Reloading saved settings; unsaved edits will be replaced.");
                setRefresh((value) => value + 1);
              }}
            >
              <RefreshCw size={15} />
              Reload saved settings
            </button>
            {settings && <span className="sx-muted">Version {settings.version}</span>}
          </div>
        </form>
      </details>
    </>
  );
}

function ManifestView({
  manifest,
  preview,
  currentPreview,
  canEdit,
  onMark,
}: {
  manifest: SynthosContextManifest;
  preview: boolean;
  currentPreview: SynthosContextManifest | null;
  canEdit: boolean;
  onMark: (path: string, field: "pinnedNotes" | "excludedPaths") => void;
}) {
  return (
    <div className="sx-context-manifest">
      <div className="sx-context-readout" data-status={manifest.status}>
        <strong>{preview ? "Prepared for preview" : "Supplied to agent"}</strong>
        <span>{manifest.status.toUpperCase()}</span>
        <span>
          {manifest.sources.length} sources · {manifest.bytes.toLocaleString()} bytes · ≈
          {manifest.estimatedTokens.toLocaleString()} tokens
        </span>
      </div>
      <p className="sx-muted">
        Selected context estimate only; full GCH rules and the remaining task packet add input.
        Provider-reported usage appears in Fuel telemetry.
      </p>
      <dl className="sx-context-metadata">
        <dt>Repository revision</dt>
        <dd>
          <code>{manifest.repositoryRevision ?? "Unavailable"}</code>
        </dd>
        <dt>Routes</dt>
        <dd>{manifest.routes.join(", ") || "No matching route"}</dd>
        <dt>Neighborhood expansion</dt>
        <dd>
          {manifest.neighborhoodUsed ? "Used" : "Not used"} · settings v{manifest.settingsVersion}
        </dd>
        <dt>Manifest fingerprint</dt>
        <dd>
          <code>{manifest.hash}</code>
        </dd>
      </dl>
      {manifest.sources.map((source) => {
        const comparison = currentPreview?.sources.find(
          (item) => item.kind === source.kind && item.path === source.path,
        );
        const changed = !preview && comparison && comparison.version !== source.version;
        return (
          <details className="sx-context-source" key={`${source.kind}:${source.path}`}>
            <summary>
              <FileText size={16} />
              <span>
                <strong>{source.path}</strong>
                <small>
                  {source.kind === "repository"
                    ? "Repository guidance"
                    : source.tier === 1
                      ? "Project memory · tier 1"
                      : "Neighborhood memory · tier 2"}
                  {source.required ? " · required" : ""}
                  {changed ? " · source changed since dispatch" : ""}
                </small>
              </span>
            </summary>
            <div>
              <p>{source.reason}</p>
              <pre>{source.excerpt}</pre>
              <p className="sx-muted">
                Source version: <code>{source.version}</code>
              </p>
              {source.kind === "obsidian" && (
                <div className="sx-actions">
                  <button
                    type="button"
                    className="sx-button"
                    disabled={!canEdit}
                    onClick={() => onMark(source.path, "pinnedNotes")}
                  >
                    <Pin size={14} />
                    Pin for future attempts
                  </button>
                  <button
                    type="button"
                    className="sx-button"
                    disabled={!canEdit}
                    onClick={() => onMark(source.path, "excludedPaths")}
                  >
                    Exclude from future recall
                  </button>
                </div>
              )}
            </div>
          </details>
        );
      })}
      {!manifest.sources.length && (
        <p className="sx-empty">
          No supplemental sources selected. The mission brief and GCH rules still apply.
        </p>
      )}
      {manifest.omissions.length > 0 && (
        <details className="sx-context-section">
          <summary>Omitted or unavailable sources · {manifest.omissions.length}</summary>
          <ul>
            {manifest.omissions.map((item) => (
              <li key={`${item.path}:${item.reason}`}>
                <strong>{item.path}</strong>: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
