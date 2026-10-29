/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useRef, useState } from "react";
import { Download, Plus, RefreshCw, Save, Trash2, Undo2 } from "lucide-react";
import type {
  EnvironmentId,
  SynthosProfile,
  SynthosProfileCommand,
  SynthosProfileInput,
  SynthosProfileResult,
} from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { synthosRequest } from "./synthosRequest";
import { refreshCrewProfileMetadata } from "./synthosCrewProfileMetadata";

export function SynthosCrewProfiles({
  environmentId,
  connected,
  draft,
  draftReady,
  onApply,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
  draft: Pick<SynthosProfileInput, "bindings" | "budget" | "checkCommands">;
  draftReady: boolean;
  onApply: (profile: SynthosProfile) => void;
}) {
  const [profiles, setProfiles] = useState<readonly SynthosProfile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<SynthosProfile | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loadedAt, setLoadedAt] = useState(-1);
  const loading = loadedAt !== refresh;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingChoice, setPendingChoice] = useState<{ profile: SynthosProfile | null } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newId = useRef(randomUUID());
  const pending = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load persistent crew profiles from the selected environment without overwriting the mission draft
  useEffect(() => {
    if (!environmentId || !connected) return;
    const controller = new AbortController();
    void synthosRequest<SynthosProfileResult>(environmentId, "/api/synthos/profiles", {
      method: "POST",
      body: { type: "list", includeDeleted: true, limit: 50 },
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.type !== "list") throw new Error("The host did not return a profile list.");
        setProfiles(result.profiles);
        setTruncated(result.truncated);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Crew profiles could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadedAt(refresh);
      });
    return () => controller.abort();
  }, [environmentId, connected, refresh]);

  function applyChoice(profile: SynthosProfile | null) {
    setSelected(profile);
    setName(profile?.name ?? "");
    setDescription(profile?.description ?? "");
    setConfirmDelete(false);
    setMessage(null);
    setError(null);
    setPendingChoice(null);
    if (!profile) newId.current = randomUUID();
  }

  function mergeLatest(profile: SynthosProfile) {
    const merged = refreshCrewProfileMetadata(
      selected ?? { name: "", description: "" },
      { name, description },
      profile,
    );
    setSelected(profile);
    setName(merged.name);
    setDescription(merged.description);
    setConfirmDelete(false);
    setPendingChoice(null);
  }

  function choose(profile: SynthosProfile | null) {
    if (profile && (profile.id === selected?.id || (!selected && profile.id === newId.current))) {
      mergeLatest(profile);
      setMessage(
        "Loaded the current profile version. Edited metadata and your mission draft are preserved.",
      );
      setError(null);
      return;
    }
    if (name !== (selected?.name ?? "") || description !== (selected?.description ?? "")) {
      setConfirmDelete(false);
      setPendingChoice({ profile });
      return;
    }
    applyChoice(profile);
  }

  async function run(command: SynthosProfileCommand) {
    if (!environmentId || !connected || pending.current || loading) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    setPendingChoice(null);
    try {
      const result = await synthosRequest<SynthosProfileResult>(
        environmentId,
        "/api/synthos/profiles",
        {
          method: "POST",
          body: command,
        },
      );
      if (result.type !== "profile") throw new Error("The host did not return the saved profile.");
      if (command.type === "get") {
        mergeLatest(result.profile);
      } else setSelected(result.profile);
      setProfiles((current) => [
        result.profile,
        ...current.filter((item) => item.id !== result.profile.id),
      ]);
      setConfirmDelete(false);
      setMessage(
        command.type === "get"
          ? "Loaded the current profile version. Edited metadata and your mission draft are preserved."
          : command.type === "delete"
            ? "Profile removed. Restore it below when needed. Existing missions are unchanged."
            : command.type === "restore"
              ? "Profile restored. Apply it explicitly to a mission draft."
              : "Crew profile saved. Mission drafts and running missions are unchanged.",
      );
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "The profile could not be saved."} Your draft is preserved. Refresh profiles, then reselect the current version before retrying a conflict.`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <details
      className="sx-crew-profiles"
      open
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <summary>
        Persistent crew profiles{" "}
        <span>{profiles.filter((profile) => !profile.deleted).length} saved</span>
      </summary>
      <p className="sx-muted">
        Save role assignments, token reservations, workflow budgets, and checks on this host.
        Applying a profile fills this draft; it does not start a mission. Profiles are reusable crew
        templates, not continuously running model sessions.
      </p>
      <div className="sx-profile-picker">
        <label className="sx-field">
          Saved crew
          <select
            value={selected?.id ?? ""}
            disabled={!connected || busy || loading}
            onChange={(event) =>
              choose(profiles.find((profile) => profile.id === event.target.value) ?? null)
            }
          >
            <option value="">New crew profile</option>
            {selected && !profiles.some((profile) => profile.id === selected.id) && (
              <option value={selected.id}>
                {selected.name} · v{selected.version} · outside current list
              </option>
            )}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · v{profile.version}
                {selected?.id === profile.id && selected.version !== profile.version
                  ? " · reload selected version"
                  : ""}
                {profile.deleted ? " · removed" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="sx-button" disabled={busy} onClick={() => choose(null)}>
          <Plus size={14} /> New
        </button>
        <button
          type="button"
          className="sx-button"
          disabled={!connected || busy || loading}
          onClick={() => {
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {pendingChoice && (
        <div className="sx-profile-confirm">
          <p>
            Switching profiles will discard the unsaved name and description. Your mission draft,
            role assignments, budget, and checks stay as they are.
          </p>
          <div className="sx-actions">
            <button
              type="button"
              className="sx-button"
              disabled={busy}
              onClick={() => applyChoice(pendingChoice.profile)}
            >
              Discard metadata and switch
            </button>
            <button type="button" className="sx-button" onClick={() => setPendingChoice(null)}>
              Keep editing
            </button>
          </div>
        </div>
      )}
      {loading && connected && (
        <p className="sx-muted" role="status">
          Loading crew profiles…
        </p>
      )}
      {truncated && (
        <p className="sx-muted">
          This list is bounded to 50 profiles and the host response limit. Older profiles remain
          available by ID through the CLI.
        </p>
      )}
      {selected && (
        <div className="sx-profile-selected">
          <p>
            <strong>{selected.name}</strong> · version {selected.version} ·{" "}
            {selected.bindings.length} roles
          </p>
          <code>{selected.id}</code>
          <button
            type="button"
            className="sx-button"
            disabled={!connected || busy || loading}
            onClick={() => void run({ type: "get", id: selected.id })}
          >
            <RefreshCw size={14} /> Reload selected version
          </button>
          <button
            type="button"
            className="sx-button"
            disabled={!connected || busy || loading || selected.deleted}
            onClick={() => {
              onApply(selected);
              setMessage(
                `Applied ${selected.name} to this draft. Review the models, budget, and checks before creating a mission.`,
              );
            }}
          >
            <Download size={14} /> Apply to draft
          </button>
        </div>
      )}
      <div className="sx-binding-grid">
        <label className="sx-field">
          Profile name
          <input
            value={name}
            maxLength={240}
            disabled={busy || selected?.deleted}
            onChange={(event) => setName(event.target.value)}
            placeholder="Midnight construction crew"
          />
        </label>
        <label className="sx-field">
          Description
          <input
            value={description}
            maxLength={2000}
            disabled={busy || selected?.deleted}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="When to use this crew"
          />
        </label>
      </div>
      <div className="sx-actions">
        {selected?.deleted ? (
          <button
            type="button"
            className="sx-button"
            disabled={!connected || busy || loading}
            onClick={() =>
              void run({ type: "restore", id: selected.id, expectedVersion: selected.version })
            }
          >
            <Undo2 size={14} /> Restore profile
          </button>
        ) : (
          <button
            type="button"
            className="sx-button"
            disabled={!connected || busy || loading || !draftReady || !name.trim()}
            onClick={() =>
              void run({
                type: "upsert",
                profile: {
                  id: selected?.id ?? newId.current,
                  name: name.trim(),
                  description,
                  ...draft,
                },
                expectedVersion: selected?.version ?? null,
              })
            }
          >
            <Save size={14} />{" "}
            {busy ? "Saving…" : selected ? "Update from draft" : "Save draft crew"}
          </button>
        )}
        {selected && !selected.deleted && !confirmDelete && (
          <button
            type="button"
            className="sx-button"
            disabled={!connected || busy || loading}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} /> Remove profile
          </button>
        )}
      </div>
      {confirmDelete && selected && (
        <div className="sx-profile-confirm">
          <p>
            Remove <strong>{selected.name}</strong> from the active list? Existing missions keep
            their copied assignments. You can restore this profile.
          </p>
          <div className="sx-actions">
            <button
              type="button"
              className="sx-button"
              disabled={!connected || busy || loading}
              onClick={() =>
                void run({ type: "delete", id: selected.id, expectedVersion: selected.version })
              }
            >
              Confirm removal
            </button>
            <button
              type="button"
              className="sx-button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Keep profile
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className="sx-muted" role="status">
          {message}
        </p>
      )}
      {!draftReady && !selected?.deleted && (
        <p className="sx-muted">
          Assign the architect, construction, lead, and reviewer to models available on this host
          before saving the crew. Unavailable saved models remain visible in the draft.
        </p>
      )}
      {error && (
        <p className="sx-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
