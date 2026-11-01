/* oxlint-disable shadcn/no-unknown-classes -- SynthOS uses a scoped, standalone stylesheet. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Download, ExternalLink, Library, Lightbulb, ScrollText, Search } from "lucide-react";
import type {
  EnvironmentId,
  SynthosConnectionStatus,
  SynthosLibraryAsset,
  SynthosLibraryCard,
  SynthosLibraryCommand,
  SynthosLibraryFormat,
  SynthosLibraryKind,
  SynthosLibraryResult,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import ChatMarkdown from "~/components/ChatMarkdown";
import { inertMarkdown } from "~/components/chat/inertMarkdown";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { synthosRequest } from "./synthosRequest";

type Answer<C extends SynthosLibraryCommand> = Extract<
  SynthosLibraryResult,
  { library: C["type"] extends `library.${infer Library}` ? Library : never }
>;
type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };
type View = "assets" | "ideas" | "principles";
type LibraryFile = Answer<{ type: "library.file"; id: string; format: SynthosLibraryFormat }>;
type Idea = Answer<{ type: "library.idea"; id: string }>;
type IdeaSummary = Answer<{ type: "library.ideas" }>["ideas"][number];
type PrincipleDocument = Answer<{ type: "library.principles" }>["documents"][number];
type Principle = Answer<{ type: "library.principle"; id: string }>;
type Detail<T> =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly value: T };

const SEARCH_DELAY_MS = 250;
const VIEWS: ReadonlyArray<{ readonly id: View; readonly label: string }> = [
  { id: "assets", label: "Assets" },
  { id: "ideas", label: "Ideas" },
  { id: "principles", label: "Principles" },
];
const KIND_LABELS: Record<SynthosLibraryKind, string> = {
  "design-system": "Design system",
  react: "React component",
  "html-component": "HTML component",
  html: "Original",
  reference: "Reference",
  principles: "Principles",
};
const KIND_FILTERS: Record<SynthosLibraryKind | "all", string> = {
  all: "All kinds",
  "design-system": "Design systems",
  react: "React components",
  "html-component": "HTML components",
  html: "Originals",
  reference: "References",
  principles: "Principles",
};
const IDEA_FILTERS = { all: "Styles and patterns", style: "Styles", pattern: "Patterns" } as const;
const FORMATS: Record<
  SynthosLibraryFormat,
  { readonly label: string; readonly extension: string; readonly type: string }
> = {
  tsx: { label: "TSX source", extension: ".tsx", type: "text/plain" },
  jsx: { label: "JSX source", extension: ".jsx", type: "text/plain" },
  html: { label: "HTML", extension: ".html", type: "text/html" },
  registry: { label: "Registry item", extension: ".registry.json", type: "application/json" },
  prompt: { label: "Agent prompt", extension: ".prompt.md", type: "text/markdown" },
  design: { label: "DESIGN.md", extension: ".design.md", type: "text/markdown" },
  framework: { label: "Tokens", extension: ".tokens.json", type: "application/json" },
};
const INERT_MARKDOWN = [inertMarkdown];
const FAILURES: Record<string, string> = {
  unavailable: "The DAM library is not available on this host. Check its configuration.",
  forbidden: "This session cannot read the DAM library.",
  not_found: "This item is not in the library, or this session cannot see it.",
  invalid_input: "DAM rejected the request. Check the search filters.",
  response_invalid: "DAM answered in a form this version of SynthOS cannot read.",
  response_too_large: "This item is too large to show here.",
  remote_rejected: "DAM could not answer this request.",
  transport: "DAM did not answer. Try again.",
  storage_only:
    "This file lives in DAM's private storage. Retrieve it through DAM's authenticated file route.",
};

function library<C extends SynthosLibraryCommand>(
  environmentId: EnvironmentId,
  command: C,
  signal?: AbortSignal,
): Promise<Answer<C>> {
  return synthosRequest<Answer<C>>(environmentId, "/api/synthos/connections", {
    method: "POST",
    body: command,
    ...(signal === undefined ? {} : { signal }),
  });
}

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function failureMessage(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined;
  if (typeof reason === "string" && Object.hasOwn(FAILURES, reason)) return FAILURES[reason]!;
  return error instanceof Error ? error.message : "The library request failed. Try again.";
}

function download(text: string, name: string, type: string) {
  // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

export function SynthosLibrary({
  environmentId,
  statuses,
}: {
  environmentId: EnvironmentId | null;
  statuses: readonly SynthosConnectionStatus[];
}) {
  const [view, setView] = useState<View>("assets");
  const [visited, setVisited] = useState<ReadonlySet<View>>(() => new Set(["assets"]));
  const status = statuses.find((item) => item.id === "dam");
  return (
    <section className="mt-10" aria-labelledby="sx-library-heading">
      <div className="sx-section-heading">
        <div>
          <h2 id="sx-library-heading">DAM library</h2>
          <p>Your asset library, read from DAM. Check licence and provenance before reuse.</p>
        </div>
      </div>
      {environmentId === null || status?.state !== "configured" ? (
        <section className="sx-panel">
          <header className="sx-panel-title">
            <Library size={17} />
            <h3>Library connection</h3>
            <span>{status?.state.toUpperCase() ?? "UNAVAILABLE"}</span>
          </header>
          <p className="sx-empty">
            {environmentId === null
              ? "Connect an environment to load its library."
              : statuses.length === 0
                ? "Loading this host's connections…"
                : (status?.reason ??
                  "This host does not offer a DAM library connection. Update its server to use one.")}
          </p>
        </section>
      ) : (
        <>
          <nav className="sx-knowledge-tabs" aria-label="Library views">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => {
                  setView(item.id);
                  setVisited((current) => new Set([...current, item.id]));
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <p className="sx-muted mb-4">{status.reason}</p>
          {visited.has("assets") && (
            <div hidden={view !== "assets"}>
              <LibraryAssets environmentId={environmentId} />
            </div>
          )}
          {visited.has("ideas") && (
            <div hidden={view !== "ideas"}>
              <LibraryIdeas environmentId={environmentId} />
            </div>
          )}
          {visited.has("principles") && (
            <div hidden={view !== "principles"}>
              <LibraryPrinciples environmentId={environmentId} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Badges({
  access,
  licence,
  frameworkStatus,
}: {
  access: SynthosLibraryCard["access"];
  licence: { readonly status: SynthosLibraryCard["licence"]["status"] };
  frameworkStatus: SynthosLibraryCard["frameworkStatus"];
}) {
  if (access !== "owner" && licence.status !== "unverified" && frameworkStatus !== "derived")
    return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {access === "owner" && <Badge variant="info">Owner only</Badge>}
      {licence.status === "unverified" && <Badge variant="warning">Licence unverified</Badge>}
      {frameworkStatus === "derived" && <Badge variant="outline">Derived tokens</Badge>}
    </div>
  );
}

function Row({
  selected,
  onOpen,
  title,
  detail,
  summary,
  children,
}: {
  selected: boolean;
  onOpen: () => void;
  title: string;
  detail: string;
  summary: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onOpen}
      className="sx-row w-full text-left hover:bg-accent aria-pressed:bg-accent"
    >
      <div className="grid min-w-0 gap-1.5">
        <strong>{title}</strong>
        <p>{detail}</p>
        {children}
        {summary && <p className="line-clamp-2">{summary}</p>}
      </div>
    </button>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="sx-limits">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Notes({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="m-0 grid gap-2">
      {rows
        .filter(([, value]) => value.trim() !== "")
        .map(([term, value]) => (
          <div key={term}>
            <dt className="sx-muted">{term}</dt>
            <dd className="m-0 whitespace-pre-line">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h4 className="m-0 font-semibold text-2xs">{children}</h4>;
}

function LibraryAssets({ environmentId }: { environmentId: EnvironmentId }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SynthosLibraryKind | "all">("all");
  const [results, setResults] = useState<Answer<{ type: "library.search" }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail<SynthosLibraryAsset>>({ state: "idle" });
  const sequence = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce DAM searches and abort superseded ones
  useEffect(() => {
    const controller = new AbortController();
    const terms = query.trim();
    const timer = setTimeout(() => {
      setSearching(true);
      void settle(
        library(
          environmentId,
          {
            type: "library.search",
            limit: 50,
            ...(terms ? { query: terms } : {}),
            ...(kind === "all" ? {} : { kind }),
          },
          controller.signal,
        ),
      ).then((outcome) => {
        if (controller.signal.aborted) return;
        setSearching(false);
        setSearchError(outcome.ok ? null : failureMessage(outcome.error));
        if (outcome.ok) setResults(outcome.value);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [environmentId, query, kind]);

  async function open(id: string) {
    const request = ++sequence.current;
    setSelected(id);
    setDetail({ state: "loading" });
    const outcome = await settle(library(environmentId, { type: "library.asset", id }));
    if (request !== sequence.current) return;
    setDetail(
      outcome.ok
        ? { state: "ready", value: outcome.value }
        : { state: "error", message: failureMessage(outcome.error) },
    );
  }

  return (
    <div className="sx-knowledge-grid">
      <section className="sx-panel">
        <header className="sx-panel-title">
          <Search size={17} />
          <h3>Assets</h3>
          <span>{results ? `${results.total} MATCHING` : ""}</span>
        </header>
        <div className="grid gap-2.5 p-4">
          <Input
            type="search"
            aria-label="Search the library"
            placeholder="Magnetic button, brutalism, tokens…"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            value={kind}
            items={KIND_FILTERS}
            onValueChange={(value) => {
              if (value !== null) setKind(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Kind">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(KIND_FILTERS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {searching && (
            <p className="sx-muted" role="status">
              Searching the library…
            </p>
          )}
          {searchError && (
            <p className="sx-error" role="alert">
              {searchError}
            </p>
          )}
        </div>
        <div className="sx-note-list">
          {results?.items.map((item) => (
            <Row
              key={item.id}
              selected={selected === item.id}
              onOpen={() => void open(item.id)}
              title={item.title}
              detail={`${KIND_LABELS[item.kind]}${item.category ? ` · ${item.category}` : ""} · ${item.licence.name}`}
              summary={item.summary}
            >
              <Badges
                access={item.access}
                licence={item.licence}
                frameworkStatus={item.frameworkStatus}
              />
            </Row>
          ))}
          {results?.items.length === 0 && (
            <p className="sx-empty">No assets matched. Try fewer words or another kind.</p>
          )}
          {results !== null && results.total > results.items.length && (
            <p className="sx-panel-note">
              Showing {results.items.length} of {results.total}. Narrow the search to find more.
            </p>
          )}
        </div>
      </section>
      <section className="sx-panel">
        <header className="sx-panel-title">
          <Library size={17} />
          <h3>{detail.state === "ready" ? detail.value.title : "Asset"}</h3>
          <span>
            {detail.state === "ready" ? KIND_LABELS[detail.value.kind].toUpperCase() : ""}
          </span>
        </header>
        {detail.state === "idle" && (
          <p className="sx-empty">
            Open an asset to see its licence, provenance and files. Its cover loads with it.
          </p>
        )}
        {detail.state === "loading" && (
          <p className="sx-empty" role="status">
            Loading the asset…
          </p>
        )}
        {detail.state === "error" && (
          <p className="sx-error m-4" role="alert">
            {detail.message}
          </p>
        )}
        {detail.state === "ready" && (
          <AssetDetail key={detail.value.id} environmentId={environmentId} asset={detail.value} />
        )}
      </section>
    </div>
  );
}

function AssetDetail({
  environmentId,
  asset,
}: {
  environmentId: EnvironmentId;
  asset: SynthosLibraryAsset;
}) {
  const coverLocation = asset.files.cover?.location;
  const [cover, setCover] = useState<Detail<string>>(
    coverLocation === "git" ? { state: "loading" } : { state: "idle" },
  );
  const [files, setFiles] = useState<Partial<Record<SynthosLibraryFormat, LibraryFile>>>({});
  const [shown, setShown] = useState<SynthosLibraryFormat | null>(null);
  const [busy, setBusy] = useState<SynthosLibraryFormat | null>(null);
  const [notice, setNotice] = useState<{ alert: boolean; text: string } | null>(null);
  const base = asset.component ? asset.component.fileName.replace(/\.[a-z]+$/, "") : asset.id;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetch the cover only once its detail has loaded, and drop it when another asset opens
  useEffect(() => {
    if (coverLocation !== "git") return;
    const controller = new AbortController();
    void settle(
      library(environmentId, { type: "library.preview", id: asset.id }, controller.signal),
    ).then((outcome) => {
      if (controller.signal.aborted) return;
      setCover(
        outcome.ok
          ? {
              state: "ready",
              value: `data:${outcome.value.mediaType};base64,${outcome.value.data}`,
            }
          : { state: "error", message: failureMessage(outcome.error) },
      );
    });
    return () => controller.abort();
  }, [environmentId, asset.id, coverLocation]);

  async function retrieve(format: SynthosLibraryFormat, action: "copy" | "download") {
    setBusy(format);
    setNotice(null);
    const cached = files[format];
    const outcome: Settled<LibraryFile> = cached
      ? { ok: true, value: cached }
      : await settle(library(environmentId, { type: "library.file", id: asset.id, format }));
    setBusy(null);
    if (!outcome.ok) {
      setNotice({ alert: true, text: failureMessage(outcome.error) });
      return;
    }
    const file = outcome.value;
    setFiles((current) => ({ ...current, [format]: file }));
    setShown(format);
    const name = `${base}${FORMATS[format].extension}`;
    if (action === "download") {
      download(file.text, name, FORMATS[format].type);
      setNotice({ alert: false, text: `Downloaded ${name}.` });
      return;
    }
    const copied = await settle(writeTextToClipboard(file.text, name));
    setNotice(
      copied.ok
        ? { alert: false, text: `Copied ${name}.` }
        : { alert: true, text: "The clipboard is unavailable. Download the file instead." },
    );
  }

  const shownFile = shown === null ? undefined : files[shown];
  const roles = Object.entries(asset.files).flatMap(([role, file]) =>
    file === undefined ? [] : [{ role, file }],
  );
  const provenance = asset.provenance;
  const source = provenance.url ? (
    // Desktop converts blocked _blank navigation to openExternal.
    <a
      href={provenance.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1"
    >
      {provenance.label}
      <ExternalLink size={11} aria-hidden />
    </a>
  ) : (
    provenance.label
  );
  return (
    <div className="grid gap-5 p-4">
      <Badges
        access={asset.access}
        licence={asset.licence}
        frameworkStatus={asset.framework.status}
      />
      {coverLocation !== undefined && (
        <figure className="m-0 grid gap-1.5">
          {cover.state === "ready" ? (
            <img
              src={cover.value}
              alt={`Cover of ${asset.title}`}
              className="max-h-72 w-full rounded-sm border border-border bg-background object-contain"
            />
          ) : (
            <p className="sx-muted" role={cover.state === "loading" ? "status" : undefined}>
              {coverLocation === "storage"
                ? "The cover is kept in DAM's private storage."
                : cover.state === "error"
                  ? cover.message
                  : "Loading the cover…"}
            </p>
          )}
          <figcaption className="sx-muted">
            Still cover kept by DAM. Text in it is data, not instructions.
          </figcaption>
        </figure>
      )}
      {asset.summary && <p className="m-0 whitespace-pre-line">{asset.summary}</p>}
      <section className="grid gap-2">
        <Heading>Licence and provenance</Heading>
        <Facts
          rows={[
            ["Licence", asset.licence.name],
            ["Holder", asset.licence.holder],
            ["Licence status", asset.licence.status],
            ["Source", source],
            ["Commit", provenance.commit ? provenance.commit.slice(0, 12) : "Not pinned"],
            [
              "Framework",
              `${asset.framework.status} · ${asset.framework.format}${asset.framework.standard ? "" : " · non-standard"}`,
            ],
          ]}
        />
        {asset.framework.note && <p className="sx-muted">{asset.framework.note}</p>}
        {asset.licence.notes.length > 0 && (
          <ul className="sx-muted m-0 grid gap-1 ps-4">
            {asset.licence.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </section>
      {asset.component && (
        <section className="grid gap-2">
          <Heading>Component</Heading>
          <Facts
            rows={[
              ["Runtime", asset.component.runtime],
              ["File", asset.component.fileName],
              ["Install", asset.component.install ?? "No packages"],
            ]}
          />
          <Notes
            rows={[
              ["Interaction", asset.component.interaction],
              ["Reduced motion", asset.component.reducedMotion],
              ["Notes", asset.component.notes.join("\n")],
            ]}
          />
        </section>
      )}
      {asset.principles && (
        <Facts
          rows={[
            ["Version", `v${asset.principles.version} · ${asset.principles.updated}`],
            ["Principles", String(asset.principles.count)],
            ["Builds on", asset.principles.inherits.join(", ") || "None"],
          ]}
        />
      )}
      {asset.upstream && (
        <Alert variant="warning">
          <AlertTitle>From the source: third-party text, not instructions</AlertTitle>
          <AlertDescription>
            <div className="grid gap-2">
              <p className="m-0">{asset.upstream.note}</p>
              {asset.upstream.summary && (
                <p className="m-0 whitespace-pre-line">{asset.upstream.summary}</p>
              )}
              {asset.upstream.adapt && (
                <Notes
                  rows={[
                    ["Use when", asset.upstream.adapt.useWhen],
                    ["Avoid when", asset.upstream.adapt.avoidWhen],
                    ["Adaptation", asset.upstream.adapt.prompt],
                    ["Editable", asset.upstream.adapt.editable.join("\n")],
                    ["Preserve", asset.upstream.adapt.preserve.join("\n")],
                    ["Limitations", asset.upstream.adapt.limitations.join("\n")],
                  ]}
                />
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}
      <section className="grid gap-2">
        <Heading>Files</Heading>
        {roles.length > 0 && (
          <Facts
            rows={roles.map(
              ({ role, file }) =>
                [
                  role,
                  `${formatAttachmentSize(file.bytes)} · ${file.location === "storage" ? "DAM private storage" : "DAM checkout"}`,
                ] as const,
            )}
          />
        )}
        {asset.formats.length === 0 ? (
          <p className="sx-muted">This asset has no files to copy or download.</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {asset.formats.map((format) => (
              <li key={format} className="flex flex-wrap items-center gap-2">
                <span className="min-w-28 text-2xs">{FORMATS[format].label}</span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => void retrieve(format, "copy")}
                >
                  <Copy aria-hidden /> Copy
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => void retrieve(format, "download")}
                >
                  <Download aria-hidden /> Download
                </Button>
              </li>
            ))}
          </ul>
        )}
        {busy !== null && (
          <p className="sx-muted" role="status">
            Retrieving {FORMATS[busy].label}…
          </p>
        )}
        {notice && (
          <p
            className={notice.alert ? "sx-error m-0" : "sx-muted"}
            role={notice.alert ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}
        {shownFile && (
          <figure className="sx-evidence m-0">
            <figcaption className="sx-muted">{shownFile.note}</figcaption>
            <pre>{shownFile.text}</pre>
          </figure>
        )}
      </section>
    </div>
  );
}

function LibraryIdeas({ environmentId }: { environmentId: EnvironmentId }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<keyof typeof IDEA_FILTERS>("all");
  const [ideas, setIdeas] = useState<ReadonlyArray<IdeaSummary> | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail<Idea>>({ state: "idle" });
  const [copied, setCopied] = useState<string | null>(null);
  const sequence = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce DAM idea searches and abort superseded ones
  useEffect(() => {
    const controller = new AbortController();
    const terms = query.trim();
    const timer = setTimeout(() => {
      setLoadingList(true);
      void settle(
        library(
          environmentId,
          {
            type: "library.ideas",
            ...(terms ? { query: terms } : {}),
            ...(kind === "all" ? {} : { kind }),
          },
          controller.signal,
        ),
      ).then((outcome) => {
        if (controller.signal.aborted) return;
        setLoadingList(false);
        setListError(outcome.ok ? null : failureMessage(outcome.error));
        if (outcome.ok) setIdeas(outcome.value.ideas);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [environmentId, query, kind]);

  async function open(id: string) {
    const request = ++sequence.current;
    setDetail({ state: "loading" });
    setCopied(null);
    const outcome = await settle(library(environmentId, { type: "library.idea", id }));
    if (request !== sequence.current) return;
    setDetail(
      outcome.ok
        ? { state: "ready", value: outcome.value }
        : { state: "error", message: failureMessage(outcome.error) },
    );
  }

  async function copyPrompt(idea: Idea) {
    const outcome = await settle(writeTextToClipboard(idea.prompt, `${idea.label} prompt`));
    setCopied(outcome.ok ? "Copied the prompt." : "The clipboard is unavailable.");
  }

  const openId = detail.state === "ready" ? detail.value.id : null;
  return (
    <div className="sx-knowledge-grid">
      <section className="sx-panel">
        <header className="sx-panel-title">
          <Lightbulb size={17} />
          <h3>Idea cards</h3>
          <span>{ideas ? `${ideas.length} CARDS` : ""}</span>
        </header>
        <div className="grid gap-2.5 p-4">
          <Input
            type="search"
            aria-label="Search idea cards"
            placeholder="Glow, skeleton, undo…"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            value={kind}
            items={IDEA_FILTERS}
            onValueChange={(value) => {
              if (value !== null) setKind(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Idea kind">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(IDEA_FILTERS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {loadingList && (
            <p className="sx-muted" role="status">
              Loading idea cards…
            </p>
          )}
          {listError && (
            <p className="sx-error" role="alert">
              {listError}
            </p>
          )}
        </div>
        <div className="sx-note-list">
          {ideas?.map((idea) => (
            <Row
              key={idea.id}
              selected={openId === idea.id}
              onOpen={() => void open(idea.id)}
              title={idea.label}
              detail={`${idea.kind === "style" ? "Style" : `Pattern · ${idea.group ?? "general"}`} · ${idea.examples} ${idea.examples === 1 ? "example" : "examples"}`}
              summary={idea.definition}
            />
          ))}
          {ideas?.length === 0 && (
            <p className="sx-empty">No idea cards matched. Try another word.</p>
          )}
        </div>
      </section>
      <section className="sx-panel">
        <header className="sx-panel-title">
          <Lightbulb size={17} />
          <h3>{detail.state === "ready" ? detail.value.label : "Idea card"}</h3>
        </header>
        {detail.state === "idle" && (
          <p className="sx-empty">Open an idea card to read its prompt, checks and examples.</p>
        )}
        {detail.state === "loading" && (
          <p className="sx-empty" role="status">
            Loading the idea card…
          </p>
        )}
        {detail.state === "error" && (
          <p className="sx-error m-4" role="alert">
            {detail.message}
          </p>
        )}
        {detail.state === "ready" && (
          <div className="grid gap-4 p-4">
            <p className="m-0">{detail.value.definition}</p>
            <Notes
              rows={[
                ["Use when", detail.value.useWhen],
                ["Avoid when", detail.value.avoidWhen],
                ["Techniques", detail.value.techniques.join(", ")],
              ]}
            />
            <section className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Heading>Prompt</Heading>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    if (detail.state === "ready") void copyPrompt(detail.value);
                  }}
                >
                  <Copy aria-hidden /> Copy prompt
                </Button>
                {copied && (
                  <span className="sx-muted" role="status">
                    {copied}
                  </span>
                )}
              </div>
              <div className="sx-evidence">
                <pre>{detail.value.prompt}</pre>
              </div>
              <p className="sx-muted">Fill in the [bracketed] parts before you use it.</p>
            </section>
            <section className="grid gap-2">
              <Heading>Checks before it ships</Heading>
              <ul className="m-0 grid gap-1 ps-4">
                {detail.value.guardrails.map((guardrail) => (
                  <li key={guardrail}>{guardrail}</li>
                ))}
              </ul>
            </section>
            {detail.value.related.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="sx-muted">Related</span>
                {detail.value.related.map((id) => (
                  <Button key={id} variant="ghost" size="xs" onClick={() => void open(id)}>
                    {id}
                  </Button>
                ))}
              </div>
            )}
            <section className="grid gap-1">
              <Heading>Examples in the library ({detail.value.examples.total})</Heading>
              {detail.value.examples.items.length === 0 ? (
                <p className="sx-muted">No visible items show this idea yet.</p>
              ) : (
                <ul className="sx-muted m-0 grid gap-1 ps-4">
                  {detail.value.examples.items.map((item) => (
                    <li key={item.id}>
                      {item.title} · {KIND_LABELS[item.kind]}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function LibraryPrinciples({ environmentId }: { environmentId: EnvironmentId }) {
  const [documents, setDocuments] = useState<Detail<ReadonlyArray<PrincipleDocument>>>({
    state: "loading",
  });
  const [detail, setDetail] = useState<Detail<Principle>>({ state: "idle" });
  const [copied, setCopied] = useState<string | null>(null);
  const sequence = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load the document list from the selected host once, and abort it on unmount
  useEffect(() => {
    const controller = new AbortController();
    void settle(library(environmentId, { type: "library.principles" }, controller.signal)).then(
      (outcome) => {
        if (controller.signal.aborted) return;
        setDocuments(
          outcome.ok
            ? { state: "ready", value: outcome.value.documents }
            : { state: "error", message: failureMessage(outcome.error) },
        );
      },
    );
    return () => controller.abort();
  }, [environmentId]);

  async function open(id: string) {
    const request = ++sequence.current;
    setDetail({ state: "loading" });
    setCopied(null);
    const outcome = await settle(library(environmentId, { type: "library.principle", id }));
    if (request !== sequence.current) return;
    setDetail(
      outcome.ok
        ? { state: "ready", value: outcome.value }
        : { state: "error", message: failureMessage(outcome.error) },
    );
  }

  async function copyDocument(principle: Principle) {
    const outcome = await settle(writeTextToClipboard(principle.text, `${principle.id}.md`));
    setCopied(outcome.ok ? "Copied the Markdown." : "The clipboard is unavailable.");
  }

  const openId = detail.state === "ready" ? detail.value.id : null;
  const openTitle =
    documents.state === "ready"
      ? documents.value.find((document) => document.id === openId)?.title
      : undefined;
  return (
    <div className="sx-knowledge-grid">
      <section className="sx-panel">
        <header className="sx-panel-title">
          <ScrollText size={17} />
          <h3>Principle documents</h3>
          <span>{documents.state === "ready" ? `${documents.value.length} DOCUMENTS` : ""}</span>
        </header>
        <p className="sx-panel-note pt-4">DAM's local server does not report review state.</p>
        <div className="sx-note-list">
          {documents.state === "loading" && (
            <p className="sx-empty" role="status">
              Loading principle documents…
            </p>
          )}
          {documents.state === "error" && (
            <p className="sx-error m-4" role="alert">
              {documents.message}
            </p>
          )}
          {documents.state === "ready" &&
            documents.value.map((document) => (
              <Row
                key={document.id}
                selected={openId === document.id}
                onOpen={() => void open(document.id)}
                title={document.title}
                detail={`v${document.version} · ${document.updated} · ${document.principles} principles${document.buildsOn.length > 0 ? ` · builds on ${document.buildsOn.join(", ")}` : ""}`}
                summary={document.summary}
              />
            ))}
          {documents.state === "ready" && documents.value.length === 0 && (
            <p className="sx-empty">
              No principle documents are visible to this session. Owner-only documents need
              SYNTHOS_DAM_OWNER=1 on the host and a session that can read files.
            </p>
          )}
        </div>
      </section>
      <section className="sx-panel">
        <header className="sx-panel-title">
          <ScrollText size={17} />
          <h3>{openTitle ?? openId ?? "Document"}</h3>
          <span>MARKDOWN</span>
        </header>
        {detail.state === "idle" && (
          <p className="sx-empty">
            Open a document to read it before you design in that discipline.
          </p>
        )}
        {detail.state === "loading" && (
          <p className="sx-empty" role="status">
            Loading the document…
          </p>
        )}
        {detail.state === "error" && (
          <p className="sx-error m-4" role="alert">
            {detail.message}
          </p>
        )}
        {detail.state === "ready" && (
          <div className="grid gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="sx-muted min-w-0 flex-1">{detail.value.note}</p>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  if (detail.state === "ready") void copyDocument(detail.value);
                }}
              >
                <Copy aria-hidden /> Copy Markdown
              </Button>
              {copied && (
                <span className="sx-muted" role="status">
                  {copied}
                </span>
              )}
            </div>
            <div className="max-h-[560px] overflow-auto">
              <ChatMarkdown
                text={detail.value.text}
                cwd={undefined}
                parseRawHtml={false}
                extraRemarkPlugins={INERT_MARKDOWN}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
