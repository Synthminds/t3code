import { SynthosKnowledgeGraph } from "./SynthosKnowledgeGraph";
/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useRef, useState } from "react";
import { BookOpen, FileText, Plus, Save, Search } from "lucide-react";
import type { EnvironmentId, SynthosConnectionStatus, SynthosMemNote } from "@t3tools/contracts";
import { synthosRequest } from "./synthosRequest";

type NoteRow = { id: string; title: string; detail: string };
type Note = { id: string; content: string; version: string | number | null };
type Source = "obsidian" | "mem";

export function SynthosKnowledge({
  environmentId,
  statuses,
}: {
  environmentId: EnvironmentId | null;
  statuses: readonly SynthosConnectionStatus[];
}) {
  const [source, setSource] = useState<Source>("obsidian");
  const [view, setView] = useState<"graph" | "notes">("graph");
  const status = statuses.find((item) => item.id === source);
  return (
    <>
      <div className="sx-section-heading">
        <div>
          <h2>Knowledge station</h2>
          <p>Read the source. Keep the context. Write with a version receipt.</p>
        </div>
      </div>
      <nav className="sx-knowledge-tabs" aria-label="Knowledge views">
        <button
          type="button"
          aria-current={view === "graph" ? "page" : undefined}
          onClick={() => setView("graph")}
        >
          Knowledge graph
        </button>
        <button
          type="button"
          aria-current={view === "notes" ? "page" : undefined}
          onClick={() => setView("notes")}
        >
          Source notes
        </button>
      </nav>
      {view === "graph" ? (
        <SynthosKnowledgeGraph
          key={environmentId ?? "disconnected"}
          environmentId={environmentId}
        />
      ) : (
        <KnowledgeSource
          key={`${environmentId}:${source}`}
          environmentId={environmentId}
          source={source}
          setSource={setSource}
          status={status}
        />
      )}
    </>
  );
}

function KnowledgeSource({
  environmentId,
  source,
  setSource,
  status,
}: {
  environmentId: EnvironmentId | null;
  source: Source;
  setSource: (source: Source) => void;
  status: SynthosConnectionStatus | undefined;
}) {
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<readonly NoteRow[]>([]);
  const [selected, setSelected] = useState<Note | null>(null);
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const sequence = useRef(0);
  const available = status?.state === "configured" && environmentId !== null;

  async function search() {
    if (!environmentId || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (source === "obsidian") {
        const result = await synthosRequest<{
          notes: readonly { path: string; title: string }[];
          truncated: boolean;
        }>(environmentId, "/api/synthos/connections", {
          method: "POST",
          body: {
            type: "obsidian.list",
            ...(query.trim() ? { query: query.trim() } : {}),
            limit: 30,
          },
        });
        setNotes(
          result.notes.map((note) => ({ id: note.path, title: note.title, detail: note.path })),
        );
        setTruncated(result.truncated);
      } else {
        const result = await synthosRequest<{
          notes: readonly { id: string; title: string; snippet: string }[];
          truncated: boolean;
        }>(environmentId, "/api/synthos/connections", {
          method: "POST",
          body: { type: "mem.search", query: query.trim(), limit: 30 },
        });
        setNotes(
          result.notes.map((note) => ({ id: note.id, title: note.title, detail: note.snippet })),
        );
        setTruncated(result.truncated);
      }
      setSearched(true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    if (!environmentId) return;
    const requestId = ++sequence.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result =
        source === "obsidian"
          ? await synthosRequest<{ path: string; content: string; version: string }>(
              environmentId,
              "/api/synthos/connections",
              { method: "POST", body: { type: "obsidian.read", path: id } },
            )
          : await synthosRequest<SynthosMemNote>(environmentId, "/api/synthos/connections", {
              method: "POST",
              body: { type: "mem.read", noteId: id },
            });
      if (requestId !== sequence.current) return;
      setSelected({ id, content: result.content, version: result.version });
      setContent(result.content);
      setPath(id);
    } catch (cause) {
      if (requestId === sequence.current) setError(message(cause));
    } finally {
      if (requestId === sequence.current) setBusy(false);
    }
  }

  async function save() {
    if (!environmentId || !selected || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (source === "obsidian") {
        const result = await synthosRequest<{ path: string; content: string; version: string }>(
          environmentId,
          "/api/synthos/connections",
          {
            method: "POST",
            body: {
              type: "obsidian.write",
              path: selected.id || path.trim(),
              content,
              expectedVersion: selected.version,
            },
          },
        );
        setSelected({ id: result.path, content: result.content, version: result.version });
        setPath(result.path);
      } else {
        const result = await synthosRequest<SynthosMemNote>(
          environmentId,
          "/api/synthos/connections",
          {
            method: "POST",
            body: {
              type: "mem.write",
              ...(selected.id ? { noteId: selected.id, expectedVersion: selected.version } : {}),
              content,
            },
          },
        );
        setSelected({ id: result.id, content: result.content, version: result.version });
      }
      setSaved(true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sx-knowledge-grid">
      <section className="sx-panel">
        <header className="sx-panel-title">
          <BookOpen size={17} />
          <h3>Knowledge sources</h3>
        </header>
        <div className="sx-knowledge-source">
          <button
            type="button"
            aria-pressed={source === "obsidian"}
            onClick={() => setSource("obsidian")}
          >
            Obsidian vault
          </button>
          <button type="button" aria-pressed={source === "mem"} onClick={() => setSource("mem")}>
            Mem
          </button>
        </div>
        <form
          className="sx-form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <span className="sx-state">{status?.state ?? "Unavailable"}</span>
          <p className="sx-muted">
            {status?.reason ?? "Connect an environment to load the source configuration."}
          </p>
          <label className="sx-field">
            {source === "obsidian" ? "Find a note by filename" : "Search your knowledge"}
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                source === "obsidian" ? "Project name or note path" : "What are you looking for?"
              }
              maxLength={256}
            />
          </label>
          <div className="sx-actions">
            <button
              type="submit"
              className="sx-button"
              disabled={!available || busy || (source === "mem" && !query.trim())}
            >
              <Search size={14} />
              {busy ? "Loading…" : source === "obsidian" && !query.trim() ? "List notes" : "Search"}
            </button>
            <button
              type="button"
              className="sx-button"
              disabled={!available || busy}
              onClick={() => {
                sequence.current++;
                setSelected({ id: "", content: "", version: null });
                setContent("");
                setPath("");
                setSaved(false);
                setError(null);
              }}
            >
              <Plus size={14} /> New note
            </button>
          </div>
        </form>
        <div className="sx-note-list">
          {notes.map((note) => (
            <button
              className="sx-note-item"
              type="button"
              key={note.id}
              onClick={() => void open(note.id)}
              aria-pressed={selected?.id === note.id}
              disabled={busy}
            >
              <strong>{note.title || note.id}</strong>
              <span>{note.detail.slice(0, 140)}</span>
            </button>
          ))}
          {searched && notes.length === 0 && (
            <p className="sx-empty">No notes matched. Try a broader search.</p>
          )}
          {truncated && (
            <p className="sx-panel-note">
              More notes are available. Narrow the search to find a specific note.
            </p>
          )}
        </div>
      </section>
      <section className="sx-panel">
        <header className="sx-panel-title">
          <FileText size={17} />
          <h3>{selected ? (selected.id ? "Source note" : "New note") : "Note workspace"}</h3>
          <span>MARKDOWN</span>
        </header>
        {selected ? (
          <form
            className="sx-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {source === "obsidian" && (
              <label className="sx-field">
                Vault path
                <input
                  value={path}
                  readOnly={Boolean(selected.id)}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="Projects/mission.md"
                  required
                />
              </label>
            )}
            <label className="sx-field">
              Full note
              <textarea
                className="sx-note-editor"
                rows={17}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setSaved(false);
                }}
                placeholder="# A new idea\n\nWrite your note in Markdown."
                required
              />
            </label>
            <p className="sx-muted">
              {selected.version !== null
                ? `Loaded version: ${selected.version}`
                : "This creates a new note in the selected source."}
            </p>
            <div className="sx-actions">
              <button
                type="submit"
                className="sx-button sx-button-primary"
                disabled={
                  !available || busy || !content.trim() || (source === "obsidian" && !path.trim())
                }
              >
                <Save size={14} />
                {busy ? "Saving…" : "Save note"}
              </button>
              {selected.id && (
                <button
                  type="button"
                  className="sx-button"
                  disabled={busy}
                  onClick={() => void open(selected.id)}
                >
                  Reload source
                </button>
              )}
              {saved && (
                <span className="sx-muted" role="status">
                  Saved with a new version.
                </span>
              )}
            </div>
          </form>
        ) : (
          <p className="sx-empty">
            Search or list your notes, then open one here. Source versions protect saved notes from
            overwriting newer edits.
          </p>
        )}
        {error && (
          <div className="sx-error" role="alert">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The knowledge request failed. Check the connection and try again.";
}
