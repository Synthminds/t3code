/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { Copy, ExternalLink, Package, RefreshCw, Search, Terminal } from "lucide-react";
import { useEnvironment } from "../../state/environments";
import type { EnvironmentId, SynthosNativeToolInventory } from "@t3tools/contracts";
import { synthosRequest } from "./synthosRequest";

const brandIcons = new Set(["github", "1password", "n8n", "obsidian", "mermaid"]);

export function SynthosSupplies({ environmentId }: { environmentId: EnvironmentId | null }) {
  const [inventory, setInventory] = useState<SynthosNativeToolInventory | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeNotice, setProbeNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const environment = useEnvironment(environmentId);
  const activityCurrent =
    environment?.connection.phase === "connected" &&
    error === null &&
    Boolean(inventory?.activityObservedAt);
  const tools = inventory?.tools ?? [];
  const categories = [...new Set(tools.map((tool) => tool.category))].sort();
  const filtered = tools.filter(
    (tool) =>
      (category === "all" || tool.category === category) &&
      `${tool.name} ${tool.description} ${tool.category} ${tool.commandName}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const selected = tools.find((tool) => tool.id === selectedId) ?? filtered[0];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read the selected host's executable inventory and discard results after navigation
  useEffect(() => {
    if (!environmentId) return;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await synthosRequest<SynthosNativeToolInventory>(
          environmentId,
          "/api/synthos/connections",
          { method: "POST", body: { type: "tools.inventory" }, signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setInventory(result);
          setError(null);
          if (refresh > 0) setCopied(false);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Tool inventory could not be loaded.");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 8_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [environmentId, refresh]);

  async function probe(toolId: string) {
    if (!environmentId || probingId) return;
    setProbingId(toolId);
    setProbeNotice(null);
    setError(null);
    try {
      await synthosRequest(environmentId, "/api/synthos/connections", {
        method: "POST",
        body: { type: "tools.probe", toolId },
      });
      const next = await synthosRequest<SynthosNativeToolInventory>(
        environmentId,
        "/api/synthos/connections",
        { method: "POST", body: { type: "tools.inventory" } },
      );
      setInventory(next);
      setProbeNotice(
        "Version check recorded on this host. Authentication and service health remain separate.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The host could not complete this probe.");
    } finally {
      setProbingId(null);
    }
  }

  return (
    <section className="sx-panel sx-supplies" aria-label="CLI supply deck">
      <header className="sx-panel-title">
        <Package size={17} />
        <h3>CLI supply deck</h3>
        <span>
          {inventory
            ? `${tools.length} CATALOG ENTRIES / ${tools.filter((tool) => tool.installed).length} FOUND ON HOST`
            : "HOST INVENTORY"}
        </span>
      </header>
      <div className="sx-supply-filters">
        <label className="sx-field">
          <span className="sr-only">Search supplies</span>
          <span className="sx-search-box">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a tool or capability…"
            />
          </span>
        </label>
        <label className="sx-field">
          <span className="sr-only">Supply category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="sx-button"
          disabled={!environmentId || busy}
          onClick={() => {
            setBusy(true);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={14} />
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p className="sx-error" role="alert">
          {error}
        </p>
      )}
      {probeNotice && (
        <p className="sx-muted" role="status">
          {probeNotice}
        </p>
      )}
      {inventory ? (
        <>
          <div className="sx-supply-grid">
            {filtered.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className="sx-cartridge"
                data-running={activityCurrent && tool.activity === "running"}
                data-probing={probingId === tool.id}
                aria-busy={probingId === tool.id}
                aria-pressed={selected?.id === tool.id}
                onClick={() => {
                  setSelectedId(tool.id);
                  setCopied(false);
                }}
              >
                <span className="sx-tool-interface">{tool.interface}</span>
                <span
                  className="sx-tool-icon"
                  aria-hidden="true"
                  style={{ maskImage: `url('/synthos/icons/${tool.id}.svg')` } as CSSProperties}
                />
                <strong>{tool.name}</strong>
                <span className="sx-tool-state">
                  {activityCurrent && tool.activity === "running"
                    ? "Running · observed"
                    : tool.availability}
                </span>
                <span className="sx-tool-probe-state">
                  {probingId === tool.id
                    ? "PROBING…"
                    : `Probe · ${tool.probe?.state ?? "unmeasured"}`}
                </span>
              </button>
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="sx-empty">
              No matching supplies.{" "}
              <button
                type="button"
                className="sx-button"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="sx-empty">
          {environmentId
            ? error
              ? "Reconnect to the host, then refresh its inventory."
              : "Reading the host’s tool inventory…"
            : "Connect an environment to inspect available supplies."}
        </p>
      )}
      {selected && (
        <div className="sx-supply-inspector">
          <div className="sx-supply-description">
            <h4>{selected.name}</h4>
            <p>{selected.description}</p>
            <p className="sx-muted">{selected.reason}</p>
            <a href={selected.docs} target="_blank" rel="noreferrer">
              Documentation <ExternalLink size={12} />
            </a>
            <small>
              {brandIcons.has(selected.id)
                ? "Original brand mark from Simple Icons (CC0)."
                : "Original GCH purpose icon. Not an official brand mark."}
            </small>
          </div>
          <div className="sx-supply-readiness">
            <dl>
              <div>
                <dt>{selected.interface === "mcp" ? "Connection" : "Executable"}</dt>
                <dd>
                  {selected.interface === "mcp"
                    ? "Remote MCP · provider managed"
                    : (selected.commandName ?? "Desktop application")}
                </dd>
              </div>
              <div>
                <dt>Configuration</dt>
                <dd>{selected.configuration.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Authentication</dt>
                <dd>{selected.authentication.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Activity</dt>
                <dd>
                  {activityCurrent && selected.activity === "running"
                    ? `Running in ${selected.activeTerminals} T3 terminal${selected.activeTerminals === 1 ? "" : "s"}`
                    : "Untracked"}
                </dd>
              </div>
            </dl>
            <div className="sx-probe-inspector">
              <strong>Version probe · {selected.probe?.state ?? "unmeasured"}</strong>
              {selected.probe?.observation && (
                <p className="sx-muted">
                  Checked {selected.probe.observation.checkedAt} ·{" "}
                  {selected.probe.observation.reason.replaceAll("_", " ")}
                  {selected.probe.observation.exitCode !== null
                    ? ` · exit ${selected.probe.observation.exitCode}`
                    : ""}
                </p>
              )}
              {selected.probe?.state === "stale" && (
                <p className="sx-muted">
                  The executable changed since this observation. Run a new check.
                </p>
              )}
              <button
                type="button"
                className="sx-button"
                disabled={!environmentId || probingId !== null || !selected.probe?.supported}
                onClick={() => void probe(selected.id)}
              >
                {probingId === selected.id ? "Checking version…" : "Run version probe"}
              </button>
              <p className="sx-muted">
                {selected.probe?.supported
                  ? "Runs one fixed version command when requested. A passing check confirms that command runs; account access and end-to-end tasks are unmeasured."
                  : "No safe version probe is registered for this tool. Its configuration and authentication status remain visible above."}
              </p>
            </div>
            {selected.handoff && (
              <div className="sx-terminal-handoff">
                <code>{selected.handoff.command}</code>
                <div className="sx-actions">
                  <button
                    type="button"
                    className="sx-button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(selected.handoff!.command)
                        .then(() => setCopied(true))
                        .catch(() =>
                          setError(
                            "Clipboard access is unavailable. Select and copy the displayed command.",
                          ),
                        );
                    }}
                  >
                    <Copy size={13} />
                    {copied ? "Copied" : "Copy command"}
                  </button>
                  <Link to="/" className="sx-button">
                    <Terminal size={13} />
                    Open workspace
                  </Link>
                </div>
                <p className="sx-muted">
                  Run the command in your T3 terminal. This handoff is outside workflow activity and
                  Stop workflow; copying does not start a process.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      <p className="sx-panel-note">
        Executable discovery does not verify authentication or service health. Activity lighting
        follows identified child processes in T3 terminals and clears on disconnect. Other sessions
        remain untracked.
      </p>
    </section>
  );
}
