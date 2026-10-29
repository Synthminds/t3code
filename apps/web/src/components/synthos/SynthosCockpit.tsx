import { randomUUID } from "../../lib/utils";
/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Bike,
  BookOpen,
  CarFront,
  CassetteTape,
  Check,
  ChevronRight,
  CirclePause,
  CirclePlay,
  GitBranch,
  Gauge,
  Inbox,
  Menu,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import type {
  EnvironmentId,
  ModelSelection,
  SynthosBinding,
  SynthosCommandInput,
  SynthosConnectionStatus,
  SynthosRole,
  SynthosWorkflow,
  SynthosProfileInput,
} from "@t3tools/contracts";
import { SYNTHOS_DEFAULT_BUDGET } from "@t3tools/contracts";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { NightRidersScene } from "./scene/NightRidersScene";
import { useSynthosWorkflows, useSynthosWorkflowDetail } from "./useSynthosWorkflows";
import { synthosRequest } from "./synthosRequest";
import { SynthosKnowledge } from "./SynthosKnowledge";
import { SynthosTools } from "./SynthosTools";
import { SynthosDevices } from "./SynthosDevices";
import { SynthosPolicyInspector } from "./SynthosPolicyInspector";
import { SynthosCrewProfiles } from "./SynthosCrewProfiles";
import { SynthosAttentionInbox } from "./SynthosAttentionInbox";
import { SynthosMemoryCapture } from "./SynthosMemoryCapture";
import { SynthosUsage } from "./SynthosUsage";
import { SynthosContextDeck } from "./SynthosContextDeck";
import { synthosAttention } from "./synthosAttention";
import "./synthos.css";

const panels = [
  { id: "cockpit", label: "Cockpit", icon: Gauge },
  { id: "inbox", label: "Needs you", icon: Inbox },
  { id: "graph", label: "Workflow", icon: GitBranch },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "decisions", label: "Decisions", icon: ShieldCheck },
  { id: "tools", label: "Tools + mail", icon: Wrench },
  { id: "devices", label: "Devices", icon: Radio },
  { id: "context", label: "Context", icon: CassetteTape },
] as const;
type Panel = (typeof panels)[number]["id"];
const roadCrew = [
  { id: "lead", name: "Lead", job: "Writer / verification", accent: "#00ead7" },
  { id: "search", name: "Search", job: "Repository scout", accent: "#ff4db8" },
  { id: "grep", name: "Grep", job: "Symbol scout", accent: "#ffc94d" },
  { id: "docs", name: "Docs", job: "Documentation scout", accent: "#b899ff" },
] as const;
const stages = [
  "intake",
  "planning",
  "build",
  "check",
  "review",
  "decision",
  "publication",
] as const;
const roleLabels: Record<SynthosRole, string> = {
  architect: "Architect",
  pm: "Project manager",
  crew: "Construction",
  lead: "Lead writer",
  search: "Repository search",
  grep: "Symbol search",
  docs: "Documentation",
  router: "Routing advisor",
  advisor: "On-call advisor",
  reviewer: "Independent review",
};

export function SynthosCockpit() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selection, setSelection] = useState<string | null>(null);
  const environment =
    environments.find((item) => item.environmentId === selection) ??
    environments.find((item) => item.environmentId === primary) ??
    environments[0];
  return (
    <SidebarInset
      className="h-dvh min-w-0 overflow-hidden"
      role="main"
      aria-label="SynthOS control room"
    >
      <div className="sx-shell flex h-full min-h-0 flex-col">
        <header className="sx-topbar">
          <div className="sx-brand-group">
            <SidebarTrigger />
            <Link to="/synthos" className="sx-brand" aria-label="SynthOS cockpit">
              SYNTH<span>OS</span>
              <i aria-hidden="true">/</i>
            </Link>
            <span className="sx-edition">NIGHT RIDERS</span>
          </div>
          <div className="sx-topbar-actions">
            <label className="sx-environment">
              <span
                className={`sx-led ${environment?.connection.phase === "connected" ? "is-on" : ""}`}
              />
              <span className="sr-only">Environment</span>
              <select
                value={environment?.environmentId ?? ""}
                onChange={(event) => setSelection(event.target.value)}
              >
                {environments.length ? (
                  environments.map((item) => (
                    <option key={item.environmentId} value={item.environmentId}>
                      {item.label}
                    </option>
                  ))
                ) : (
                  <option value="">No environment</option>
                )}
              </select>
            </label>
            <Link
              to="/settings/connections"
              className="sx-icon-button"
              aria-label="Connection settings"
            >
              <Settings2 size={17} />
            </Link>
            <Link to="/" className="sx-workspace-link">
              <Terminal size={15} /> Workspace <ArrowRight size={14} />
            </Link>
          </div>
        </header>
        <CockpitEnvironment
          key={environment?.environmentId ?? "disconnected"}
          environmentId={environment?.environmentId ?? null}
          connected={environment?.connection.phase === "connected"}
        />
      </div>
    </SidebarInset>
  );
}

function CockpitEnvironment({
  environmentId,
  connected,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
}) {
  const workflows = useSynthosWorkflows(environmentId);
  const allThreads = useThreadShells();
  const threads = allThreads.filter(
    (thread) => thread.environmentId === environmentId && !thread.archivedAt,
  );
  const activeThreads = connected
    ? threads.filter((thread) => thread.runtime?.status === "running")
    : [];
  const [panel, setPanel] = useState<Panel>("cockpit");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<SynthosRole>("lead");
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [camera, setCamera] = useState<0 | 1 | 2>(0);
  const [statuses, setStatuses] = useState<readonly SynthosConnectionStatus[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const summary = workflows.data.find((item) => item.id === selectedId) ?? workflows.data[0];
  const detail = useSynthosWorkflowDetail(environmentId, summary);
  const selected = detail.data ?? summary;
  const activeAttempt = selected?.attempts.find(
    (attempt) => attempt.id === selected.activeAttemptId,
  );
  const activeThread = threads.find((thread) => thread.id === activeAttempt?.threadId);
  const running =
    connected &&
    selected?.status === "running" &&
    (activeAttempt?.status === "pending" || activeAttempt?.status === "running") &&
    activeThread?.runtime?.status === "running";
  const vehicles = roadCrew.map((role) => ({
    id: role.id,
    active: Boolean(running && activeAttempt?.role === role.id),
    selected: selectedRole === role.id,
  }));
  const pending = workflows.data.filter((workflow) => workflow.status === "waiting_decision");
  const attentionCount =
    workflows.data.filter((workflow) => synthosAttention(workflow) !== null).length +
    threads.filter(
      (thread) =>
        thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest,
    ).length;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load connection configuration from the selected environment and abort it on unmount
  useEffect(() => {
    if (!environmentId) return;
    const controller = new AbortController();
    void synthosRequest<{ connections: readonly SynthosConnectionStatus[] }>(
      environmentId,
      "/api/synthos/connections",
      { method: "POST", body: { type: "status" }, signal: controller.signal },
    )
      .then((result) => setStatuses(result.connections))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setConnectionError(
            cause instanceof Error ? cause.message : "Connection inventory could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [environmentId]);

  async function command(action: SynthosCommandInput["action"], reason?: string) {
    if (!selected || busy) return;
    if (action === "approve" && !detail.ready) {
      setActionError("Load the complete current evidence before approving this workflow.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await workflows.command(selected, action, reason);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Command failed. Refresh to inspect the recorded state.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sx-scroll">
      <section
        className="sx-highway"
        aria-label="Night Riders activity visualization"
        data-focus={focused}
      >
        <div className="sx-scene-toolbar">
          <div>
            <h1>
              NIGHT <span>RIDERS</span>
            </h1>
            <p>CODE HARD. DRIVE RAD.</p>
          </div>
          <div className="sx-scene-controls">
            <button type="button" onClick={() => setFocused(!focused)} aria-pressed={focused}>
              <Menu size={14} />
              <span>{focused ? "Arcade view" : "Focus view"}</span>
            </button>
            <button
              type="button"
              onClick={() => setCamera((value) => ((value + 1) % 3) as 0 | 1 | 2)}
              disabled={focused}
            >
              <CarFront size={15} />
              <span>{["Chase", "Passenger", "Driver"][camera]}</span>
            </button>
            <button type="button" onClick={() => setPaused(!paused)} aria-pressed={paused}>
              {paused ? <CirclePlay size={15} /> : <CirclePause size={15} />}
              <span>{paused ? "Resume motion" : "Pause motion"}</span>
            </button>
          </div>
        </div>
        {!focused && (
          <div className="sx-road">
            <NightRidersScene
              vehicles={vehicles}
              moving={Boolean(running)}
              paused={paused}
              camera={camera}
              onSelect={(role) => {
                setSelectedRole(role);
                setPanel("context");
              }}
            />
            <div className="sx-scene-status">
              <span className={`sx-led ${running ? "is-on" : ""}`} />
              {!connected
                ? "ENVIRONMENT OFFLINE"
                : running
                  ? "OBSERVED RUN / ENGINES ON"
                  : "PARKED / AWAITING DISPATCH"}
            </div>
            <div className="sx-scene-stamp" aria-hidden="true">
              MIDNIGHT PROTOCOL
              <br />
              <span>MAXIMUM OVERDRIVE</span>
            </div>
            <div className="sx-highway-caption">
              <strong>
                THE FUTURE
                <br />
                IS AFTER HOURS.
              </strong>
              <span>SELECT A VEHICLE TO INSPECT ITS ROLE</span>
            </div>
          </div>
        )}
        <div className="sx-crew">
          {roadCrew.map((role, index) => {
            const attempt = selected?.attempts.findLast((item) => item.role === role.id);
            const binding = selected?.bindings.find((item) => item.role === role.id);
            return (
              <button
                type="button"
                key={role.id}
                onClick={() => {
                  setSelectedRole(role.id);
                  setPanel("context");
                }}
                aria-pressed={selectedRole === role.id}
                className="sx-rider"
                style={{ "--role-accent": role.accent } as CSSProperties}
                data-active={vehicles[index]?.active}
              >
                <span className="sx-rider-icon">
                  {index === 0 ? (
                    <CarFront size={29} strokeWidth={1.3} />
                  ) : (
                    <Bike size={29} strokeWidth={1.3} />
                  )}
                </span>
                <span>
                  <strong>{role.name}</strong>
                  <small>{role.job}</small>
                </span>
                <span className="sx-rider-state">
                  {!connected
                    ? "Offline"
                    : vehicles[index]?.active
                      ? "Running"
                      : attempt?.status === "running"
                        ? "Dispatch recorded"
                        : attempt
                          ? attempt.status
                          : binding
                            ? "Assigned"
                            : "Unassigned"}
                </span>
              </button>
            );
          })}
        </div>
        <div className="sx-telemetry">
          <span>
            <Activity size={12} /> {activeThreads.length} live T3{" "}
            {activeThreads.length === 1 ? "thread" : "threads"}
          </span>
          <span>
            {selected
              ? `${selected.title} / ${selected.status.replaceAll("_", " ")}`
              : "NO WORKFLOW SELECTED"}
          </span>
          <span>{paused ? "MOTION PAUSED" : running ? "LIVE ACTIVITY" : "SCENERY AT REST"}</span>
        </div>
      </section>
      <nav className="sx-navigation" aria-label="Control room panels">
        {panels.map((item) => (
          <button
            key={item.id}
            type="button"
            className={panel === item.id ? "is-active" : ""}
            aria-current={panel === item.id ? "page" : undefined}
            onClick={() => setPanel(item.id)}
          >
            <item.icon size={17} />
            <span>{item.label}</span>
            {item.id === "decisions" && pending.length > 0 && <b>{pending.length}</b>}
            {item.id === "inbox" && attentionCount > 0 && <b>{attentionCount}</b>}
          </button>
        ))}
      </nav>
      <div className="sx-workarea">
        {!connected && (
          <div className="sx-notice">
            <Radio size={17} />
            <span>Connect an environment to load workflows, agents, and knowledge.</span>
            <Link to="/settings/connections">
              Connections <ArrowRight size={14} />
            </Link>
          </div>
        )}
        {workflows.error && (
          <div className="sx-error" role="alert">
            <span>{workflows.error}</span>
            <button type="button" onClick={workflows.reload}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        )}
        {detail.error && (
          <div className="sx-error" role="alert">
            <span>{detail.error}</span>
            <button
              type="button"
              onClick={() => {
                workflows.reload();
                detail.reload();
              }}
            >
              Reload evidence
            </button>
          </div>
        )}
        {detail.loading && (panel === "graph" || panel === "decisions") && (
          <p className="sx-muted sx-loading-evidence" role="status">
            Loading the full evidence for this workflow revision…
          </p>
        )}
        {actionError && (
          <div className="sx-error" role="alert">
            {actionError}
          </div>
        )}
        <SynthosPolicyInspector
          key={`${environmentId}:${connected}`}
          environmentId={environmentId}
          connected={connected}
          workflow={selected}
        />
        {(panel === "cockpit" ||
          panel === "graph" ||
          panel === "decisions" ||
          panel === "context") && (
          <div className="sx-section-heading">
            <div>
              <h2>
                {panel === "cockpit"
                  ? "Mission control"
                  : panel === "graph"
                    ? "Workflow circuit"
                    : panel === "context"
                      ? "Context deck"
                      : "Decision desk"}
              </h2>
              <p>
                {panel === "cockpit"
                  ? "Set the mission. Bind your crew. Inspect every handoff."
                  : panel === "graph"
                    ? "From intent to evidence. Every stage has a receipt."
                    : panel === "context"
                      ? "Tune the signal. Inspect what each agent receives."
                      : "Review the evidence before authorizing the next step."}
              </p>
            </div>
            <div className="sx-workflow-picker">
              <label htmlFor="sx-workflow">Workflow</label>
              <select
                id="sx-workflow"
                value={selected?.id ?? ""}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                <option value="" disabled>
                  {workflows.loading ? "Loading workflows…" : "No workflows yet"}
                </option>
                {workflows.data.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="sx-icon-button"
                aria-label="Refresh workflows"
                onClick={workflows.reload}
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
        )}
        {panel === "inbox" && (
          <SynthosAttentionInbox
            workflows={workflows.data}
            threads={threads}
            connected={connected}
            loading={workflows.loading}
            error={workflows.error}
            onRefresh={workflows.reload}
            onSelect={(id, decision) => {
              setSelectedId(id);
              setPanel(decision ? "decisions" : "graph");
            }}
          />
        )}
        <div hidden={panel !== "cockpit"}>
          <div className="sx-dashboard-grid">
            <MissionComposer
              environmentId={environmentId}
              connected={connected}
              onCreated={(id) => {
                setSelectedId(id);
                workflows.reload();
              }}
            />
            <div className="sx-right-stack">
              <RoleInspector
                role={selectedRole}
                workflow={selected}
                environmentId={environmentId}
              />
              <section className="sx-panel">
                <header className="sx-panel-title">
                  <Terminal size={16} />
                  <h3>Thread uplink</h3>
                  <span>{threads.length}</span>
                </header>
                <div className="sx-thread-list">
                  {threads.slice(0, 5).map((thread) => (
                    <Link
                      key={thread.id}
                      to="/$environmentId/$threadId"
                      params={{ environmentId: thread.environmentId, threadId: thread.id }}
                      className="sx-thread"
                    >
                      <span
                        className={`sx-led ${connected && thread.runtime?.status === "running" ? "is-on" : ""}`}
                      />
                      <span>
                        <strong>{thread.title || "Untitled thread"}</strong>
                        <small>
                          {thread.modelSelection.model} ·{" "}
                          {connected ? (thread.runtime?.status ?? "idle") : "offline"}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </Link>
                  ))}
                  {threads.length === 0 && (
                    <p className="sx-empty">
                      Your T3 project threads appear here. Open the workspace to create your first
                      thread.
                    </p>
                  )}
                </div>
                <Link to="/" className="sx-panel-link">
                  Open editor + terminal <ArrowRight size={14} />
                </Link>
              </section>
            </div>
          </div>
        </div>
        {panel === "graph" && <WorkflowGraph workflow={selected} environmentId={environmentId} />}
        <div hidden={panel !== "graph"}>
          <SynthosUsage
            environmentId={environmentId}
            connected={connected}
            workflow={selected}
            detailReady={detail.ready}
          />
        </div>
        {panel === "decisions" && (
          <DecisionDesk
            key={`${selected?.id ?? "none"}:${selected?.revision ?? 0}`}
            workflow={selected}
            environmentId={environmentId}
            detailReady={detail.ready}
            busy={busy}
            connected={connected}
            onCommand={command}
          />
        )}
        <div hidden={panel !== "decisions"}>
          <SynthosMemoryCapture
            environmentId={environmentId}
            connected={connected}
            workflow={detail.ready ? (selected ?? null) : null}
          />
        </div>
        {panel === "context" && (
          <SynthosContextDeck
            key={`${environmentId}:${selected?.id ?? "none"}`}
            environmentId={environmentId}
            connected={connected}
            workflow={detail.ready ? selected : undefined}
            loading={detail.loading}
            role={selectedRole}
            onRoleChange={setSelectedRole}
          />
        )}
        {panel === "knowledge" && (
          <SynthosKnowledge
            environmentId={environmentId}
            statuses={statuses}
            activeWorkflow={selected}
          />
        )}
        {panel === "tools" && <SynthosTools environmentId={environmentId} statuses={statuses} />}
        {panel === "devices" && (
          <SynthosDevices environmentId={environmentId} statuses={statuses} />
        )}
        {connectionError && (panel === "knowledge" || panel === "tools" || panel === "devices") && (
          <p className="sx-error" role="alert">
            {connectionError}
          </p>
        )}
        {(panel === "cockpit" || panel === "graph") && selected && (
          <div className="sx-command-strip">
            <span className="sx-state">{selected.status.replaceAll("_", " ")}</span>
            <span>
              {selected.blockReason ?? `Stage: ${selected.stage} · Revision ${selected.revision}`}
            </span>
            <div className="sx-actions">
              {selected.status === "proposed" && (
                <button
                  type="button"
                  className="sx-button sx-button-primary"
                  disabled={busy || !connected}
                  onClick={() => void command("start")}
                >
                  <CirclePlay size={15} /> Start workflow
                </button>
              )}
              {selected.status === "blocked" && (
                <button
                  type="button"
                  className="sx-button"
                  disabled={busy || !connected}
                  onClick={() => void command("retry")}
                >
                  Retry stage
                </button>
              )}
              {selected.status === "running" && (
                <button
                  type="button"
                  className="sx-button"
                  disabled={busy || !connected}
                  onClick={() => void command("reconcile")}
                >
                  <RefreshCw size={14} /> Reconcile
                </button>
              )}
              {selected.status === "waiting_decision" && (
                <button
                  type="button"
                  className="sx-button sx-button-primary"
                  onClick={() => setPanel("decisions")}
                >
                  Review decision <ArrowRight size={14} />
                </button>
              )}
              {!["completed", "cancelled"].includes(selected.status) && (
                <button
                  type="button"
                  className="sx-button sx-button-danger"
                  disabled={busy || !connected}
                  onClick={() => void command("cancel")}
                >
                  <Square size={12} /> Stop workflow
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <footer className="sx-footer">
        <span>SYNTHMINDS / MIDNIGHT PROTOCOL</span>
        <span>
          HUMAN AT THE HELM <ShieldCheck size={13} />
        </span>
      </footer>
    </div>
  );
}

function MissionComposer({
  environmentId,
  connected,
  onCreated,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
  onCreated: (id: string) => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId ? (providersByEnvironment.get(environmentId) ?? []) : [];
  const choices = providers
    .filter((provider) => provider.enabled && provider.installed)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.instanceId}:${model.slug}`,
        label: `${model.name} / ${provider.displayName ?? provider.instanceId}`,
        selection: { instanceId: provider.instanceId, model: model.slug } satisfies ModelSelection,
      })),
    );
  const [projectId, setProjectId] = useState("");
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const [task, setTask] = useState("");
  const [independentReview, setIndependentReview] = useState(false);
  const [roles, setRoles] = useState<Partial<Record<SynthosRole, SynthosBinding>>>({});
  const [budget, setBudget] = useState<SynthosProfileInput["budget"]>(SYNTHOS_DEFAULT_BUDGET);
  const [checks, setChecks] = useState("");
  const bindings = Object.values(roles).filter(
    (binding): binding is SynthosBinding => binding !== undefined,
  );
  const checkCommands = checks
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const requiredRoles = ["architect", "crew", "lead", "reviewer"] as const;
  const crewReady =
    requiredRoles.every((role) => roles[role] !== undefined) &&
    bindings.every((binding) =>
      choices.some(
        (choice) =>
          choice.selection.instanceId === binding.modelSelection.instanceId &&
          choice.selection.model === binding.modelSelection.model,
      ),
    );
  function assign(role: SynthosRole, key: string) {
    const choice = choices.find((item) => item.key === key);
    setRoles((current) => {
      const next = { ...current };
      if (choice)
        next[role] = {
          role,
          modelSelection: choice.selection,
          inputTokenLimit: current[role]?.inputTokenLimit ?? 24000,
          outputTokenLimit: current[role]?.outputTokenLimit ?? 8000,
        };
      else delete next[role];
      return next;
    });
  }
  function bindingEditor(role: SynthosRole) {
    const binding = roles[role];
    const key = binding
      ? `${binding.modelSelection.instanceId}:${binding.modelSelection.model}`
      : "";
    return (
      <div className="sx-crew-binding" key={role}>
        <label className="sx-field">
          {roleLabels[role]}
          <select value={key} onChange={(event) => assign(role, event.target.value)}>
            <option value="">
              {requiredRoles.some((item) => item === role)
                ? "Choose an available model"
                : "Unassigned"}
            </option>
            {binding && !choices.some((choice) => choice.key === key) && (
              <option value={key}>
                Unavailable: {binding.modelSelection.model} / {binding.modelSelection.instanceId}
              </option>
            )}
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {binding && (
          <label className="sx-field">
            Backup model
            <select
              value={
                binding.backupModelSelection
                  ? `${binding.backupModelSelection.instanceId}:${binding.backupModelSelection.model}`
                  : ""
              }
              onChange={(event) => {
                const backup = choices.find((choice) => choice.key === event.target.value);
                setRoles((current) => {
                  const { backupModelSelection: _old, ...primary } = binding;
                  return {
                    ...current,
                    [role]: {
                      ...primary,
                      ...(backup ? { backupModelSelection: backup.selection } : {}),
                    },
                  };
                });
              }}
            >
              <option value="">No automatic fallback</option>
              {choices.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {binding && (
          <div className="sx-role-reservations">
            <label className="sx-field">
              Input tokens
              <input
                aria-label={`${roleLabels[role]} input token reservation`}
                type="number"
                min={1}
                max={125000}
                step={1}
                value={binding.inputTokenLimit}
                onChange={(event) =>
                  setRoles((current) => ({
                    ...current,
                    [role]: { ...binding, inputTokenLimit: Number(event.target.value) },
                  }))
                }
              />
            </label>
            <label className="sx-field">
              Output tokens
              <input
                aria-label={`${roleLabels[role]} output token reservation`}
                type="number"
                min={1}
                max={64000}
                step={1}
                value={binding.outputTokenLimit}
                onChange={(event) =>
                  setRoles((current) => ({
                    ...current,
                    [role]: { ...binding, outputTokenLimit: Number(event.target.value) },
                  }))
                }
              />
            </label>
          </div>
        )}
        {binding?.modelSelection.options && (
          <small className="sx-muted">
            Saved provider options are preserved until you choose another model.
          </small>
        )}
      </div>
    );
  }
  const proposalIdentity = useRef<{
    signature: string;
    workflowId: string;
    commandId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    if (!environmentId || !project || !task.trim() || !crewReady) return;
    setBusy(true);
    setError(null);
    const signature = JSON.stringify({
      projectId: project.id,
      task: task.trim(),
      reviewMode: independentReview ? "independent" : "standard",
      bindings,
      checks,
      budget,
    });
    const identity =
      proposalIdentity.current?.signature === signature
        ? proposalIdentity.current
        : { signature, workflowId: randomUUID(), commandId: randomUUID() };
    proposalIdentity.current = identity;
    try {
      await synthosRequest(environmentId, "/api/synthos/workflows", {
        method: "POST",
        body: {
          commandId: identity.commandId,
          workflowId: identity.workflowId,
          projectId: project.id,
          title: task.trim().split("\n")[0]!.slice(0, 100),
          task: task.trim(),
          reviewMode: independentReview ? "independent" : "standard",
          bindings,
          checkCommands,
          budget,
        },
      });
      onCreated(identity.workflowId);
      proposalIdentity.current = null;
      setTask("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The mission could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sx-panel sx-mission">
      <header className="sx-panel-title">
        <Radio size={17} />
        <h3>Transmit a mission</h3>
        <span>DRAFT → REVIEW → RUN</span>
      </header>
      <form
        className="sx-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="sx-field">
          Project
          <select value={project?.id ?? ""} onChange={(event) => setProjectId(event.target.value)}>
            <option value="" disabled>
              Select a project
            </option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label className="sx-field">
          Mission brief
          <textarea
            rows={4}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="What are we building tonight? Include the outcome and how we’ll verify it."
            maxLength={12000}
            required
          />
        </label>
        <label className="sx-field">
          <span>
            <input
              type="checkbox"
              checked={independentReview}
              onChange={(event) => setIndependentReview(event.target.checked)}
            />{" "}
            Require independent review for a sensitive or broad-impact mission
          </span>
        </label>
        <SynthosCrewProfiles
          environmentId={environmentId}
          connected={connected}
          draft={{ bindings, budget, checkCommands }}
          draftReady={crewReady}
          onApply={(profile) => {
            setRoles(
              Object.fromEntries(profile.bindings.map((binding) => [binding.role, binding])),
            );
            setBudget(profile.budget);
            setChecks(profile.checkCommands.join("\n"));
          }}
        />
        <details className="sx-bindings" open>
          <summary>
            Crew assignments <span>{bindings.length} bound</span>
          </summary>
          <div className="sx-binding-grid">{requiredRoles.map(bindingEditor)}</div>
          <p className="sx-muted">
            Lead verification requires numeric command exit receipts from its provider. An adapter
            that cannot report them holds at the evidence gate. Choose the actual qualified model
            from this host’s catalog.
          </p>
          <details className="sx-optional-bindings">
            <summary>Scouts + advisory roles</summary>
            <div className="sx-binding-grid">
              {(["search", "grep", "docs", "pm", "router", "advisor"] as const).map(bindingEditor)}
            </div>
            <p className="sx-muted">
              Bound scouts and routing roles run during planning. The advisor is available at the
              decision gate. Each dispatch creates a T3 thread and records its evidence.
            </p>
          </details>
          {choices.length === 0 && (
            <p className="sx-muted">
              No installed model catalog is available.{" "}
              <Link to="/settings/providers">Configure providers</Link> to assign your crew.
            </p>
          )}
        </details>
        <details className="sx-bindings sx-budget-editor">
          <summary>
            Workflow budget <span>{budget.maxTokens.toLocaleString()} tokens reserved at most</span>
          </summary>
          <div className="sx-binding-grid">
            {(
              [
                ["durationMs", "Deadline (seconds)", 1800, 0.001],
                ["maxLoops", "Review loops", 5, 1],
                ["maxBuilds", "Build attempts", 3, 1],
                ["maxAdvisorCalls", "Advisor calls", 3, 0],
                ["maxAdvisorTokens", "Advisor input tokens", 125000, 0],
                ["maxTokens", "Total token budget", undefined, 1],
              ] as const
            ).map(([field, label, max, min]) => (
              <label className="sx-field" key={field}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={field === "durationMs" ? 0.001 : 1}
                  value={field === "durationMs" ? budget[field] / 1000 : budget[field]}
                  onChange={(event) =>
                    setBudget((current) => ({
                      ...current,
                      [field]:
                        field === "durationMs"
                          ? Math.round(Number(event.target.value) * 1000)
                          : Number(event.target.value),
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <p className="sx-muted">
            These admission limits bound new dispatches. They are not a provider-side hard spending
            cap.
          </p>
        </details>
        <label className="sx-field">
          Verification commands <span>One command per line</span>
          <textarea
            rows={2}
            value={checks}
            onChange={(event) => setChecks(event.target.value)}
            placeholder="e.g. pnpm test"
          />
        </label>
        <div className="sx-submit-line">
          <p>
            {crewReady
              ? "Creates a proposal. Starting the workflow is a separate action."
              : "Bind all required roles to available host models before creating this proposal."}
          </p>
          <button
            type="submit"
            className="sx-button sx-button-primary"
            disabled={busy || !connected || !project || !task.trim() || !crewReady}
          >
            {busy ? "Saving…" : "Create mission"}
            <ArrowRight size={16} />
          </button>
        </div>
        {error && (
          <p className="sx-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function RoleInspector({
  role,
  workflow,
  environmentId,
}: {
  role: SynthosRole;
  workflow: SynthosWorkflow | undefined;
  environmentId: EnvironmentId | null;
}) {
  const binding = workflow?.bindings.find((item) => item.role === role);
  const attempts = workflow?.attempts.filter((item) => item.role === role) ?? [];
  const latest = attempts.at(-1);
  return (
    <section className="sx-panel sx-role-inspector">
      <header className="sx-panel-title">
        {role === "lead" ? <CarFront size={17} /> : <Bike size={17} />}
        <h3>{roleLabels[role]}</h3>
        <span>ROLE INSPECTOR</span>
      </header>
      <div className="sx-instrument">
        <div>
          <span>MODEL BINDING</span>
          <strong>{binding?.modelSelection.model ?? "Awaiting assignment"}</strong>
          <p>
            {binding
              ? `Provider: ${binding.modelSelection.instanceId}`
              : "Choose a crew assignment when creating a mission."}
          </p>
        </div>
        <dl>
          <div>
            <dt>Observed attempts</dt>
            <dd>{attempts.length}</dd>
          </div>
          <div>
            <dt>Recorded attempt</dt>
            <dd>{latest?.status ?? "Not dispatched"}</dd>
          </div>
          <div>
            <dt>Input / output budget</dt>
            <dd>
              {binding
                ? `${binding.inputTokenLimit.toLocaleString()} / ${binding.outputTokenLimit.toLocaleString()}`
                : "Unassigned"}
            </dd>
          </div>
        </dl>
        {latest && environmentId && (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: latest.threadId }}
            className="sx-panel-link"
          >
            Inspect source thread <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </section>
  );
}

function WorkflowGraph({
  workflow,
  environmentId,
}: {
  workflow: SynthosWorkflow | undefined;
  environmentId: EnvironmentId | null;
}) {
  const currentIndex = workflow ? stages.indexOf(workflow.stage) : -1;
  return (
    <>
      <section className="sx-panel">
        <header className="sx-panel-title">
          <GitBranch size={17} />
          <h3>Production circuit</h3>
          <span>{workflow ? workflow.status.replaceAll("_", " ") : "AWAITING MISSION"}</span>
        </header>
        <ol className="sx-pipeline">
          {stages.map((stage, index) => (
            <li
              key={stage}
              data-stage={
                index === currentIndex ? "current" : index < currentIndex ? "past" : "future"
              }
            >
              <span className="sx-stage-mark">
                {index < currentIndex ? <Check size={17} /> : index + 1}
              </span>
              <strong>{stage}</strong>
              <small>
                {index === currentIndex
                  ? workflow?.status.replaceAll("_", " ")
                  : index < currentIndex
                    ? "Reached"
                    : "Not reached"}
              </small>
            </li>
          ))}
        </ol>
      </section>
      <div className="sx-split">
        <section className="sx-panel">
          <header className="sx-panel-title">
            <Activity size={17} />
            <h3>Execution receipts</h3>
            <span>{workflow?.attempts.length ?? 0}</span>
          </header>
          {workflow?.attempts.length ? (
            <div className="sx-list">
              {workflow.attempts.map((attempt) => (
                <div className="sx-receipt" key={attempt.id}>
                  <div>
                    <strong>{roleLabels[attempt.role]}</strong>
                    <span className="sx-state">{attempt.status}</span>
                  </div>
                  <p>
                    {attempt.stage} · {attempt.inputTokens.toLocaleString()} input /{" "}
                    {attempt.outputTokens.toLocaleString()} output tokens
                    {!attempt.usageComplete ? " · usage incomplete" : ""}
                  </p>
                  {attempt.result && <pre>{attempt.result}</pre>}
                  {attempt.resultOmitted && (
                    <p className="sx-muted">
                      This is an excerpt. Open the source thread below to inspect the complete
                      result.
                    </p>
                  )}
                  {attempt.packetOmitted ? (
                    <p className="sx-muted">
                      The context packet is omitted from this snapshot. Load the full evidence or
                      inspect the source thread.
                    </p>
                  ) : attempt.packetHtml ? (
                    <details className="sx-packet">
                      <summary>Dispatch context packet</summary>
                      <pre>{attempt.packetHtml}</pre>
                      <code>{attempt.packetHash}</code>
                    </details>
                  ) : null}
                  {environmentId && (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: attempt.threadId }}
                    >
                      Open thread <ArrowRight size={13} />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="sx-empty">
              No dispatch receipts yet. Create a mission and bind its crew to begin.
            </p>
          )}
        </section>
        <section className="sx-panel">
          <header className="sx-panel-title">
            <ShieldCheck size={17} />
            <h3>Operating limits</h3>
          </header>
          <dl className="sx-limits">
            <div>
              <dt>Loops</dt>
              <dd>{workflow ? `${workflow.usage.loops} / ${workflow.budget.maxLoops}` : "N/A"}</dd>
            </div>
            <div>
              <dt>Build attempts</dt>
              <dd>
                {workflow ? `${workflow.usage.builds} / ${workflow.budget.maxBuilds}` : "N/A"}
              </dd>
            </div>
            <div>
              <dt>Advisor calls</dt>
              <dd>
                {workflow
                  ? `${workflow.usage.advisorCalls} / ${workflow.budget.maxAdvisorCalls}`
                  : "N/A"}
              </dd>
            </div>
            <div>
              <dt>Tokens observed</dt>
              <dd>
                {workflow
                  ? (workflow.usage.inputTokens + workflow.usage.outputTokens).toLocaleString()
                  : "N/A"}
              </dd>
            </div>
            <div>
              <dt>Usage completeness</dt>
              <dd>
                {workflow
                  ? workflow.usage.incompleteUsage
                    ? "Incomplete"
                    : "Complete"
                  : "No evidence"}
              </dd>
            </div>
            <div>
              <dt>Policy version</dt>
              <dd>{workflow?.policyVersion ?? "Not loaded"}</dd>
            </div>
            <div>
              <dt>Policy fingerprint</dt>
              <dd className="sx-policy-hash">{workflow?.policyHash ?? "Not loaded"}</dd>
            </div>
            <div>
              <dt>Publication</dt>
              <dd>{workflow?.publication.status.replaceAll("_", " ") ?? "Not requested"}</dd>
            </div>
          </dl>
          <p className="sx-panel-note">
            Model recommendations stay advisory. The workflow records transitions and requires a
            human publication decision.
          </p>
        </section>
      </div>
    </>
  );
}

function DecisionDesk({
  workflow,
  busy,
  connected,
  environmentId,
  detailReady,
  onCommand,
}: {
  workflow: SynthosWorkflow | undefined;
  busy: boolean;
  connected: boolean;
  environmentId: EnvironmentId | null;
  detailReady: boolean;
  onCommand: (action: SynthosCommandInput["action"], reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [reviewedSource, setReviewedSource] = useState(false);
  const review = workflow?.attempts.findLast((attempt) => attempt.stage === "review");
  const awaiting = workflow?.status === "waiting_decision" && detailReady;
  const canApprove = awaiting && (!review?.resultOmitted || reviewedSource);
  return (
    <div className="sx-split">
      <section className="sx-panel">
        <header className="sx-panel-title">
          <ShieldCheck size={17} />
          <h3>Evidence packet</h3>
          <span>
            {workflow?.status === "waiting_decision"
              ? detailReady
                ? "AWAITING YOU"
                : "LOADING EVIDENCE"
              : "NO PENDING DECISION"}
          </span>
        </header>
        {workflow ? (
          <div className="sx-form">
            <h3 className="sx-mission-title">{workflow.title}</h3>
            <p>{workflow.task}</p>
            <div className="sx-evidence">
              <span>INDEPENDENT REVIEW</span>
              <pre>
                {detailReady
                  ? review?.result || "The reviewer has not produced an evidence packet yet."
                  : "The complete revision is loading. Decisions remain locked until its evidence is available."}
              </pre>
              {review?.resultOmitted && (
                <p className="sx-muted">
                  This stored review is an excerpt. Inspect the full source thread before approving.
                </p>
              )}
              {review && environmentId && (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: review.threadId }}
                  className="sx-panel-link"
                >
                  Inspect complete review thread <ArrowRight size={14} />
                </Link>
              )}
              {review?.packetOmitted && (
                <p className="sx-muted">The dispatch packet is omitted from this response.</p>
              )}
              {review?.evidenceHash && <code>{review.evidenceHash}</code>}
            </div>
            <p className="sx-muted">
              Approval authorizes the reviewed publication package. Provider publication must be
              configured before anything can be published externally.
            </p>
            {workflow.decision && (
              <div className="sx-decision-record">
                <Check size={17} />
                <span>
                  {workflow.decision.action} · {workflow.decision.reason || "No reason provided"}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="sx-empty">
            When a workflow reaches its decision gate, its review and check evidence appear here.
          </p>
        )}
      </section>
      <section className="sx-panel">
        <header className="sx-panel-title">
          <Radio size={17} />
          <h3>Your call</h3>
        </header>
        <div className="sx-form">
          <label className="sx-field">
            Decision note
            <textarea
              rows={5}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain the approval, request changes, or record why this should stop."
            />
          </label>
          {review?.resultOmitted && (
            <label className="sx-source-ack">
              <input
                type="checkbox"
                checked={reviewedSource}
                onChange={(event) => setReviewedSource(event.target.checked)}
                disabled={!detailReady}
              />
              <span>I reviewed the complete result in its source thread.</span>
            </label>
          )}
          <div className="sx-actions">
            <button
              type="button"
              className="sx-button sx-button-primary"
              disabled={!canApprove || busy || !connected}
              onClick={() => void onCommand("approve", reason)}
            >
              <Check size={15} /> Approve package
            </button>
            <button
              type="button"
              className="sx-button"
              disabled={!awaiting || busy || !connected}
              onClick={() => void onCommand("revise", reason)}
            >
              Request revision
            </button>
            <button
              type="button"
              className="sx-button sx-button-danger"
              disabled={!awaiting || busy || !connected}
              onClick={() => void onCommand("reject", reason)}
            >
              Reject
            </button>
          </div>
          {workflow?.bindings.some((binding) => binding.role === "advisor") && (
            <button
              type="button"
              className="sx-button"
              disabled={
                !awaiting ||
                busy ||
                !connected ||
                workflow.usage.advisorCalls >= workflow.budget.maxAdvisorCalls
              }
              onClick={() => void onCommand("advisor", reason)}
            >
              Consult advisor ({workflow.usage.advisorCalls}/{workflow.budget.maxAdvisorCalls})
            </button>
          )}
          <p className="sx-muted">
            Every decision records the actor, revision, and evidence fingerprint.
          </p>
        </div>
      </section>
    </div>
  );
}
