import {
  NonNegativeInt,
  SYNTHOS_LIBRARY_MAX_PREVIEW_BYTES,
  SYNTHOS_LIBRARY_MAX_TEXT_BYTES,
  SynthosConnectionError,
  SynthosLibraryFormat,
  SynthosLibraryIdea,
  SynthosLibraryIdeaSummary,
  SynthosLibraryKind,
  SynthosLibraryPatternFacet,
  SynthosLibraryPrincipleDocument,
  SynthosLibraryStyleFacet,
  type AuthEnvironmentScope,
  SynthosLibraryAsset,
  type SynthosLibraryCard,
  type SynthosLibraryCommand,
  type SynthosLibraryResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ConnectionsConfig from "./ConnectionsConfig.ts";

type Mode = "public" | "owner";
type Reason = SynthosConnectionError["reason"];
type RpcResponse =
  | { readonly _tag: "result"; readonly value: unknown }
  | { readonly _tag: "error"; readonly code: number };

interface DamConnection {
  readonly open: () => boolean;
  readonly request: (
    method: string,
    params: unknown,
    timeout: Duration.Input,
  ) => Effect.Effect<RpcResponse, SynthosConnectionError>;
}

export const CALL_TIMEOUT = Duration.seconds(10);
export const START_TIMEOUT = Duration.seconds(30);
const FORCE_KILL_AFTER = Duration.seconds(2);
export const IDLE_TIME_TO_LIVE = Duration.minutes(5);
// A cover preview is about 1.4 MiB of JSON (DAM's 1 MiB cap in base64); text files are smaller.
export const MAX_MESSAGE_BYTES = 2 * 1_048_576;
// A flood stops a process, not a long uptime: DAM logs a stack trace per INTERNAL answer.
export const MAX_STDERR_BYTES = 262_144;
export const STDERR_WINDOW = Duration.seconds(10);
const STDERR_BUCKET_MILLIS = 100;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const INVALID_PARAMS = -32_602;
// PATH locates node, the temp variables tsx's compile cache; node needs SystemRoot on Windows.
const FORWARDED_ENVIRONMENT = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;
const FILE_ROLES = [
  "cover",
  "design",
  "framework",
  "original",
  "source",
  "jsx",
  "standalone",
  "preview",
] as const;

export class DamLibrary extends Context.Service<
  DamLibrary,
  {
    readonly execute: (
      actor: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
      command: SynthosLibraryCommand,
    ) => Effect.Effect<SynthosLibraryResult, SynthosConnectionError>;
  }
>()("t3/synthos-connections/DamLibrary") {}

const failure = (reason: Reason, cause?: unknown) =>
  new SynthosConnectionError({
    connection: "dam",
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
const invalid = (cause: unknown) => failure("response_invalid", cause);
const isConnectionError = Schema.is(SynthosConnectionError);
const logIssue = (code: string, mode: Mode) =>
  Effect.logWarning("DAM library connection issue").pipe(Effect.annotateLogs({ code, mode }));

// DAM's output is untrusted: types and bounds are strict; fields older DAMs omit are optional.
const Text = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const List = <S extends Schema.Constraint>(item: S, maxLength: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maxLength));
const Access = Schema.Literals(["public", "owner"]);
const LicenceStatus = Schema.Literals(["verified", "unverified"]);
const FrameworkStatus = Schema.Literals(["provided", "needed", "derived"]);

const DamCard = Schema.Struct({
  id: Id,
  title: Text(200),
  kind: SynthosLibraryKind,
  category: Schema.NullOr(Text(80)),
  summary: Text(1_000),
  tags: List(Text(50), 20),
  styles: Schema.optionalKey(List(Id, 20)),
  patterns: Schema.optionalKey(List(Id, 20)),
  licence: Text(120),
  formats: List(SynthosLibraryFormat, 7),
  access: Schema.optionalKey(Access),
  licenceStatus: Schema.optionalKey(LicenceStatus),
  frameworkStatus: Schema.optionalKey(FrameworkStatus),
});
type DamCard = typeof DamCard.Type;
// List envelopes keep their bounds; each entry is decoded on its own (decodeEntries).
const Entries = (maxLength: number) => List(Schema.Unknown, maxLength);
const DamSearch = Schema.Struct({ total: NonNegativeInt, items: Entries(50) });

const DamFile = Schema.Struct({
  bytes: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  location: Schema.optionalKey(Schema.Literals(["git", "storage"])),
});
const DamAsset = Schema.Struct({
  id: Id,
  title: Text(200),
  kind: SynthosLibraryKind,
  access: Schema.optionalKey(Access),
  category: Schema.NullOr(Text(80)),
  summary: Schema.optionalKey(Text(10_000)),
  tags: List(Text(50), 20),
  facets: Schema.optionalKey(Schema.Struct({ styles: List(Id, 20), patterns: List(Id, 20) })),
  framework: Schema.Struct({
    status: FrameworkStatus,
    format: Text(120),
    standard: Schema.Boolean,
    note: Schema.NullOr(Text(400)),
  }),
  licence: Schema.Struct({
    name: Text(120),
    holder: Text(200),
    status: LicenceStatus,
    notes: List(Text(400), 200),
  }),
  source: Schema.Struct({
    label: Text(200),
    url: Schema.NullOr(Text(2_048).check(Schema.isPattern(/^https:\/\/\S+$/))),
    commit: Schema.NullOr(Text(80)),
  }),
  formats: List(SynthosLibraryFormat, 7),
  files: Schema.Struct({
    cover: Schema.optionalKey(DamFile),
    design: Schema.optionalKey(DamFile),
    framework: Schema.optionalKey(DamFile),
    original: Schema.optionalKey(DamFile),
    source: Schema.optionalKey(DamFile),
    jsx: Schema.optionalKey(DamFile),
    standalone: Schema.optionalKey(DamFile),
    preview: Schema.optionalKey(DamFile),
  }),
  component: Schema.optionalKey(
    Schema.Struct({
      format: Schema.Literals(["react", "html"]),
      fileName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,78}\.(?:tsx|html)$/)),
      exportName: Schema.NullOr(Text(80)),
      install: Schema.optionalKey(Schema.NullOr(Text(3_000))),
      runtime: Text(120),
      packages: List(Schema.Struct({ name: Text(220), version: Text(61) }), 10),
      requires: List(Text(80), 8),
      props: List(
        Schema.Struct({
          name: Text(61),
          type: Text(200),
          default: Schema.NullOr(Text(120)),
          description: Text(400),
        }),
        20,
      ),
      interaction: Text(400),
      reducedMotion: Text(400),
      notes: List(Text(400), 12),
    }),
  ),
  principles: SynthosLibraryAsset.fields.principles,
  upstream: SynthosLibraryAsset.fields.upstream,
});
type DamAsset = typeof DamAsset.Type;

const { library: _idea, ...ideaFields } = SynthosLibraryIdea.fields;
const DamIdea = Schema.Struct(ideaFields);
const DamIdeas = Schema.Struct({ total: NonNegativeInt, ideas: Entries(200) });
const DamPrinciples = Schema.Struct({ total: NonNegativeInt, documents: Entries(100) });
const DamFacets = Schema.Struct({ styles: Entries(100), patterns: Entries(100) });
const DamPreview = Schema.Struct({ contentType: Text(40), bytes: NonNegativeInt });
const DamNote = Text(2_000);

const RpcMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  method: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number })),
});
const ToolResult = Schema.Struct({
  content: List(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
      data: Schema.optionalKey(Schema.String),
      mimeType: Schema.optionalKey(Schema.String),
    }),
    8,
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});
const InitializeResult = Schema.Struct({ protocolVersion: Text(40) });

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(RpcMessage));
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeInitialize = Schema.decodeUnknownEffect(InitializeResult);
const decodeSearch = Schema.decodeUnknownEffect(Schema.fromJsonString(DamSearch));
const decodeCard = Schema.decodeUnknownEffect(DamCard);
const decodeAsset = Schema.decodeUnknownEffect(Schema.fromJsonString(DamAsset));
const decodeIdeas = Schema.decodeUnknownEffect(Schema.fromJsonString(DamIdeas));
const decodeIdeaSummary = Schema.decodeUnknownEffect(SynthosLibraryIdeaSummary);
const decodeIdea = Schema.decodeUnknownEffect(Schema.fromJsonString(DamIdea));
const decodePrinciples = Schema.decodeUnknownEffect(Schema.fromJsonString(DamPrinciples));
const decodePrincipleDocument = Schema.decodeUnknownEffect(SynthosLibraryPrincipleDocument);
const decodeFacets = Schema.decodeUnknownEffect(Schema.fromJsonString(DamFacets));
const decodeStyle = Schema.decodeUnknownEffect(SynthosLibraryStyleFacet);
const decodePattern = Schema.decodeUnknownEffect(SynthosLibraryPatternFacet);
const decodePreview = Schema.decodeUnknownEffect(Schema.fromJsonString(DamPreview));
const decodeNote = Schema.decodeUnknownEffect(DamNote);
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const lineEncoder = new TextEncoder();

// DAM tool errors start with a code; older DAMs send plain messages.
function damToolErrorReason(message: string): Reason {
  switch (/^([A-Z_]+): /.exec(message)?.[1]) {
    case "NOT_FOUND":
    case "NOT_AVAILABLE":
      return "not_found";
    case "INVALID":
      return "invalid_input";
    case "TOO_LARGE":
      return "response_too_large";
    case "STORAGE_ONLY":
      return "storage_only";
    case "INTERNAL":
      return "remote_rejected";
  }
  return /^No (?:asset|idea|principle document) /.test(message) ? "not_found" : "remote_rejected";
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const issuePath = (error: Schema.SchemaError) =>
  (formatIssue(error.issue).issues[0]?.path ?? [])
    .map((segment) => String(typeof segment === "object" ? segment.key : segment))
    .join(".");
// Only an id in DAM's own id alphabet reaches a log line.
const loggableId = (entry: unknown) => {
  const id = typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined;
  return typeof id === "string" && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(id) ? id : null;
};

// A list entry this version cannot read (a newer kind, format or bound) is dropped rather than
// failing the page, and logged by id and schema path only: never its values.
const decodeEntries = Effect.fn("DamLibrary.decodeEntries")(function* <A>(
  decode: (entry: unknown) => Effect.Effect<A, Schema.SchemaError>,
  entries: ReadonlyArray<unknown>,
  tool: string,
  mode: Mode,
) {
  const decoded = yield* Effect.forEach(entries, (entry) =>
    decode(entry).pipe(
      Effect.map((value) => [value]),
      Effect.catch((error) =>
        Effect.logWarning("DAM library entry dropped").pipe(
          Effect.annotateLogs({
            code: "DAM_ENTRY_DROPPED",
            mode,
            tool,
            id: loggableId(entry),
            path: issuePath(error),
          }),
          Effect.as([]),
        ),
      ),
    ),
  );
  return decoded.flat();
});

// Sliding over 100 ms buckets, so a burst that straddles any boundary still counts in one window:
// every STDERR_WINDOW span (and at most one bucket more) is held to MAX_STDERR_BYTES.
export function makeStderrBudget() {
  const windowBuckets = Duration.toMillis(STDERR_WINDOW) / STDERR_BUCKET_MILLIS;
  const buckets = new Map<number, number>();
  let total = 0;
  return (bytes: number) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const bucket = Math.floor(now / STDERR_BUCKET_MILLIS);
      for (const [key, held] of buckets) {
        if (key >= bucket - windowBuckets) break;
        buckets.delete(key);
        total -= held;
      }
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + bytes);
      total += bytes;
      return total > MAX_STDERR_BYTES;
    });
}

const CAPABILITIES = [
  "library.search",
  "library.facets",
  "library.asset",
  "library.file",
  "library.preview",
  "library.ideas",
  "library.idea",
  "library.principles",
  "library.principle",
];

function libraryStatus(config: ConnectionsConfig.ConnectionsConfig["Service"]) {
  const checkout = config.damRoot
    ? "DAM checkout configured; availability is checked when first used."
    : "Set SYNTHOS_DAM_ROOT to a DAM checkout with its dependencies installed on this host.";
  const owner =
    config.damOwner === "on"
      ? "Owner-only items are on for sessions that can read files on this host."
      : config.damOwner === "unrecognized"
        ? "SYNTHOS_DAM_OWNER has a value SynthOS does not recognize, so owner-only items are off; set it to 1 or true to show them to sessions that can read files."
        : "Owner-only items are off; set SYNTHOS_DAM_OWNER=1 to show them to sessions that can read files.";
  return {
    library: "status",
    state: config.damRoot ? "configured" : "unavailable",
    capabilities: CAPABILITIES,
    reason: `${checkout} ${owner}`,
  } as const;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const matchesImageType = (bytes: Uint8Array, mediaType: "image/png" | "image/webp") =>
  mediaType === "image/png"
    ? PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    : String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";

// When DAM omits access, the owner process can serve owner-only items, so it is assumed.
const defaultAccess = (mode: Mode) => (mode === "owner" ? "owner" : "public");
// An older DAM omits access and its public process lists public items only.
const listsNonPublic = (entry: unknown) =>
  typeof entry === "object" && entry !== null && "access" in entry && entry.access !== "public";

const toCard = (item: DamCard, mode: Mode): SynthosLibraryCard => ({
  id: item.id,
  title: item.title,
  kind: item.kind,
  category: item.category,
  summary: item.summary,
  tags: item.tags,
  styles: item.styles ?? [],
  patterns: item.patterns ?? [],
  formats: item.formats,
  access: item.access ?? defaultAccess(mode),
  licence: { name: item.licence, status: item.licenceStatus ?? "unknown" },
  frameworkStatus: item.frameworkStatus ?? "unknown",
});

function toFiles(files: DamAsset["files"]): SynthosLibraryAsset["files"] {
  const mapped: {
    -readonly [Role in keyof SynthosLibraryAsset["files"]]: SynthosLibraryAsset["files"][Role];
  } = {};
  for (const role of FILE_ROLES) {
    const file = files[role];
    if (file)
      mapped[role] = { bytes: file.bytes, sha256: file.sha256, location: file.location ?? "git" };
  }
  return mapped;
}

const toAsset = (asset: DamAsset, mode: Mode): SynthosLibraryAsset => ({
  library: "asset",
  id: asset.id,
  title: asset.title,
  kind: asset.kind,
  category: asset.category,
  summary: asset.summary ?? "",
  tags: asset.tags,
  styles: asset.facets?.styles ?? [],
  patterns: asset.facets?.patterns ?? [],
  access: asset.access ?? defaultAccess(mode),
  licence: asset.licence,
  provenance: asset.source,
  framework: asset.framework,
  formats: asset.formats,
  files: toFiles(asset.files),
  ...(asset.component === undefined
    ? {}
    : { component: { ...asset.component, install: asset.component.install ?? null } }),
  ...(asset.principles === undefined ? {} : { principles: asset.principles }),
  ...(asset.upstream === undefined ? {} : { upstream: asset.upstream }),
});

const make = Effect.gen(function* () {
  const config = yield* ConnectionsConfig.ConnectionsConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inherited = yield* HostProcess.Environment;
  const environment: Record<string, string> = {};
  for (const key of FORWARDED_ENVIRONMENT) {
    const value = inherited[key];
    if (value !== undefined) environment[key] = value;
  }
  let verifiedRoot: string | undefined;

  const resolveRoot = Effect.fn("DamLibrary.resolveRoot")(function* (mode: Mode) {
    if (verifiedRoot !== undefined) return verifiedRoot;
    const configured = config.damRoot;
    if (configured === undefined) return yield* failure("unavailable");
    if (!path.isAbsolute(configured)) {
      yield* logIssue("DAM_ROOT_INVALID", mode);
      return yield* failure("unavailable");
    }
    const isType = (target: string, type: FileSystem.File.Type) =>
      fs.stat(target).pipe(
        Effect.map((info) => info.type === type),
        Effect.orElseSucceed(() => false),
      );
    const root = yield* fs.realPath(configured).pipe(Effect.orElseSucceed(() => null));
    if (
      root === null ||
      !(yield* isType(root, "Directory")) ||
      !(yield* isType(path.join(root, "package.json"), "File")) ||
      !(yield* isType(path.join(root, "scripts", "mcp", "server.ts"), "File"))
    ) {
      yield* logIssue("DAM_ROOT_INVALID", mode);
      return yield* failure("unavailable");
    }
    if (!(yield* isType(path.join(root, "node_modules", "tsx", "package.json"), "File"))) {
      yield* logIssue("DAM_DEPENDENCIES_MISSING", mode);
      return yield* failure("unavailable");
    }
    verifiedRoot = root;
    return root;
  });

  // Owns one DAM process for the scope RcMap gives this entry; closing it stops the process group.
  const connect = Effect.fn("DamLibrary.connect")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    mode: Mode,
  ) {
    const scope = yield* Effect.scope;
    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const pending = new Map<number, Deferred.Deferred<RpcResponse, SynthosConnectionError>>();
    let closed = false;
    let nextId = 0;

    const close = (error: SynthosConnectionError, code: string) =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        const waiting = [...pending.values()];
        pending.clear();
        return Effect.forEach(waiting, (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        }).pipe(
          Effect.andThen(logIssue(code, mode)),
          Effect.andThen(
            Effect.forkIn(Effect.ignore(handle.kill({ forceKillAfter: FORCE_KILL_AFTER })), scope),
          ),
          Effect.asVoid,
        );
      });

    // Per-line routing shares the connection's span; a span per message would be noise.
    const route = Effect.fnUntraced(function* (bytes: Uint8Array) {
      const line = yield* Effect.try({ try: () => utf8.decode(bytes), catch: invalid });
      if (line.trim() === "") return;
      const message = yield* decodeMessage(line).pipe(Effect.mapError(invalid));
      // DAM sends no notifications or requests; only answers to our numeric ids matter.
      if (message.method !== undefined || typeof message.id !== "number") return;
      const deferred = pending.get(message.id);
      if (deferred === undefined) return;
      pending.delete(message.id);
      const response: RpcResponse =
        message.error === undefined
          ? { _tag: "result", value: message.result }
          : { _tag: "error", code: message.error.code };
      yield* Deferred.succeed(deferred, response);
    });

    let parts: Array<Uint8Array> = [];
    let size = 0;
    // A line over the cap cannot be attributed to one request, so the whole connection closes.
    const readChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
        const piece = chunk.subarray(start, end);
        size += piece.byteLength;
        if (size > MAX_MESSAGE_BYTES) return yield* failure("response_too_large");
        parts.push(piece);
        const line = parts.length === 1 ? piece : Buffer.concat(parts, size);
        parts = [];
        size = 0;
        start = end + 1;
        yield* route(line);
      }
      const rest = chunk.subarray(start);
      size += rest.byteLength;
      if (size > MAX_MESSAGE_BYTES) return yield* failure("response_too_large");
      if (rest.byteLength > 0) parts.push(rest);
    });

    yield* Stream.runForEach(handle.stdout, readChunk).pipe(
      Effect.matchEffect({
        onSuccess: () => close(failure("transport"), "DAM_PROCESS_EXITED"),
        onFailure: (error) =>
          isConnectionError(error)
            ? close(error, "DAM_PROTOCOL_VIOLATION")
            : close(failure("transport", error), "DAM_STDOUT_FAILED"),
      }),
      Effect.forkScoped,
    );
    const overStderrBudget = makeStderrBudget();
    yield* Stream.runForEach(handle.stderr, (chunk) =>
      Effect.flatMap(overStderrBudget(chunk.byteLength), (over) =>
        over ? close(failure("transport"), "DAM_STDERR_LIMIT") : Effect.void,
      ),
    ).pipe(Effect.ignore, Effect.forkScoped);
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(handle.stdin),
      Effect.catch((cause) => close(failure("transport", cause), "DAM_STDIN_FAILED")),
      Effect.forkScoped,
    );

    const send = (message: unknown) =>
      Queue.offer(outgoing, lineEncoder.encode(`${encodeMessage(message)}\n`));

    const request: DamConnection["request"] = Effect.fn("DamLibrary.request")(
      function* (method, params, timeout) {
        const deferred = yield* Deferred.make<RpcResponse, SynthosConnectionError>();
        const id = yield* Effect.sync(() => {
          if (closed) return undefined;
          nextId += 1;
          pending.set(nextId, deferred);
          return nextId;
        });
        if (id === undefined) return yield* failure("transport");
        yield* send({ jsonrpc: "2.0", id, method, params });
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              close(failure("transport"), "DAM_CALL_TIMEOUT").pipe(
                Effect.andThen(Effect.fail(failure("transport"))),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      },
    );

    const initialized = yield* request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "synthos", version: "1.0.0" },
      },
      START_TIMEOUT,
    );
    if (initialized._tag === "error") return yield* failure("remote_rejected");
    yield* decodeInitialize(initialized.value).pipe(Effect.mapError(invalid));
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { open: () => !closed, request } satisfies DamConnection;
  });

  const start = Effect.fn("DamLibrary.start")(function* (mode: Mode) {
    const root = yield* resolveRoot(mode);
    // tsx's loader keeps DAM in one process (its CLI runs a child); the spawner signals the
    // whole process group on release, SIGTERM then SIGKILL. DAM exits on unknown arguments.
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          "node",
          ["--import", "tsx", "scripts/mcp/server.ts", ...(mode === "owner" ? ["--owner"] : [])],
          {
            cwd: root,
            env: environment,
            extendEnv: false,
            shell: false,
            forceKillAfter: FORCE_KILL_AFTER,
          },
        ),
      )
      .pipe(
        Effect.mapError((cause) => failure("unavailable", cause)),
        // Synchronous spawn throws arrive as defects.
        Effect.catchDefect((cause) => Effect.fail(failure("unavailable", cause))),
        Effect.tapError(() => logIssue("DAM_SPAWN_FAILED", mode)),
      );
    return yield* connect(handle, mode).pipe(
      Effect.tapError(() => logIssue("DAM_INITIALIZE_FAILED", mode)),
      Effect.mapError((cause) => failure("unavailable", cause)),
    );
  });

  const connections = yield* RcMap.make({
    lookup: start,
    idleTimeToLive: IDLE_TIME_TO_LIVE,
  });

  // A cached failure or a dead process is dropped so the next request starts a fresh one.
  const acquire = Effect.fn("DamLibrary.acquire")(
    function* (mode: Mode) {
      const current = yield* RcMap.get(connections, mode);
      if (current.open()) return current;
      yield* RcMap.invalidate(connections, mode);
      return yield* RcMap.get(connections, mode);
    },
    (effect, mode) => effect.pipe(Effect.tapError(() => RcMap.invalidate(connections, mode))),
  );

  const callTool = Effect.fn("DamLibrary.callTool")(function* (
    mode: Mode,
    tool: string,
    args: Record<string, unknown>,
  ) {
    const connection = yield* acquire(mode);
    const response = yield* connection.request(
      "tools/call",
      { name: tool, arguments: args },
      CALL_TIMEOUT,
    );
    if (response._tag === "error")
      // Only a DAM that predates a tool answers its call with invalid params.
      return yield* failure(
        tool === "get_asset_preview" && response.code === INVALID_PARAMS
          ? "not_found"
          : "remote_rejected",
      );
    const result = yield* decodeToolResult(response.value).pipe(Effect.mapError(invalid));
    const texts = result.content.flatMap((block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    );
    if (result.isError === true) return yield* failure(damToolErrorReason(texts[0] ?? ""));
    return { texts, content: result.content };
  }, Effect.scoped);

  const readAsset = Effect.fn("DamLibrary.readAsset")(function* (mode: Mode, id: string) {
    const { texts } = yield* callTool(mode, "get_asset", { id });
    const asset = yield* decodeAsset(texts[0]).pipe(Effect.mapError(invalid));
    // Defence in depth: a public session never receives an item DAM marks owner-only.
    if (mode === "public" && asset.access === "owner") return yield* failure("not_found");
    return asset;
  });

  const readDocument = Effect.fn("DamLibrary.readDocument")(function* (
    texts: ReadonlyArray<string>,
  ) {
    const [header, text] = texts;
    if (header === undefined || text === undefined) return yield* failure("response_invalid");
    if (Buffer.byteLength(text, "utf8") > SYNTHOS_LIBRARY_MAX_TEXT_BYTES)
      return yield* failure("response_too_large");
    return { note: yield* decodeNote(header).pipe(Effect.mapError(invalid)), text };
  });

  const execute: DamLibrary["Service"]["execute"] = Effect.fn("DamLibrary.execute")(
    function* (actor, command) {
      if (command.type === "library.status") return libraryStatus(config);
      if (config.damRoot === undefined) return yield* failure("unavailable");
      const mode: Mode =
        config.damOwner === "on" && actor.scopes.includes("filesystem:read") ? "owner" : "public";
      yield* Effect.annotateCurrentSpan({ "dam.mode": mode, "dam.command": command.type });
      switch (command.type) {
        case "library.search": {
          const { type: _type, ...args } = command;
          const { texts } = yield* callTool(mode, "search_assets", args);
          const value = yield* decodeSearch(texts[0]).pipe(Effect.mapError(invalid));
          // Checked on the raw entries, before any is dropped: a public process that lists an item
          // it does not mark public is broken, and its count is not trustworthy either.
          if (mode === "public" && value.items.some(listsNonPublic)) {
            yield* logIssue("DAM_ACCESS_VIOLATION", mode);
            return yield* failure("response_invalid");
          }
          const cards = yield* decodeEntries(decodeCard, value.items, "search_assets", mode);
          return {
            library: "search",
            total: value.total,
            items: cards.map((item) => toCard(item, mode)),
            dropped: value.items.length - cards.length,
          };
        }
        case "library.facets": {
          const { texts } = yield* callTool(mode, "list_facets", {});
          const value = yield* decodeFacets(texts[0]).pipe(Effect.mapError(invalid));
          return {
            library: "facets",
            styles: yield* decodeEntries(decodeStyle, value.styles, "list_facets", mode),
            patterns: yield* decodeEntries(decodePattern, value.patterns, "list_facets", mode),
          };
        }
        case "library.asset":
          return toAsset(yield* readAsset(mode, command.id), mode);
        case "library.file": {
          const asset = yield* readAsset(mode, command.id);
          const { texts } = yield* callTool(mode, "get_asset_file", {
            id: command.id,
            format: command.format,
          });
          const document = yield* readDocument(texts);
          return {
            library: "file",
            id: asset.id,
            format: command.format,
            title: asset.title,
            access: asset.access ?? defaultAccess(mode),
            licence: {
              name: asset.licence.name,
              holder: asset.licence.holder,
              status: asset.licence.status,
            },
            framework: { status: asset.framework.status },
            ...document,
          };
        }
        case "library.preview": {
          // The asset read checks access and supplies the licence the cover travels with.
          const asset = yield* readAsset(mode, command.id);
          const { texts, content } = yield* callTool(mode, "get_asset_preview", { id: command.id });
          const meta = yield* decodePreview(texts[0]).pipe(Effect.mapError(invalid));
          const image = content.find((block) => block.type === "image");
          const mediaType = image?.mimeType;
          if (
            image?.data === undefined ||
            (mediaType !== "image/png" && mediaType !== "image/webp") ||
            mediaType !== meta.contentType
          )
            return yield* failure("response_invalid");
          if (image.data.length > Math.ceil(SYNTHOS_LIBRARY_MAX_PREVIEW_BYTES / 3) * 4)
            return yield* failure("response_too_large");
          const bytes = Base64.decode(image.data);
          if (
            Result.isFailure(bytes) ||
            bytes.success.byteLength !== meta.bytes ||
            !matchesImageType(bytes.success, mediaType)
          )
            return yield* failure("response_invalid");
          return {
            library: "preview",
            id: asset.id,
            mediaType,
            data: image.data,
            bytes: meta.bytes,
            licence: {
              name: asset.licence.name,
              holder: asset.licence.holder,
              status: asset.licence.status,
            },
          };
        }
        case "library.ideas": {
          const { type: _type, ...args } = command;
          const { texts } = yield* callTool(mode, "list_ideas", args);
          const value = yield* decodeIdeas(texts[0]).pipe(Effect.mapError(invalid));
          return {
            library: "ideas",
            total: value.total,
            ideas: yield* decodeEntries(decodeIdeaSummary, value.ideas, "list_ideas", mode),
          };
        }
        case "library.idea": {
          const { texts } = yield* callTool(mode, "get_idea", { id: command.id });
          return {
            library: "idea",
            ...(yield* decodeIdea(texts[0]).pipe(Effect.mapError(invalid))),
          };
        }
        case "library.principles": {
          const { texts } = yield* callTool(mode, "list_principles", {});
          const value = yield* decodePrinciples(texts[0]).pipe(Effect.mapError(invalid));
          return {
            library: "principles",
            total: value.total,
            documents: yield* decodeEntries(
              decodePrincipleDocument,
              value.documents,
              "list_principles",
              mode,
            ),
          };
        }
        case "library.principle": {
          const { texts } = yield* callTool(mode, "get_principles", { id: command.id });
          return { library: "principle", id: command.id, ...(yield* readDocument(texts)) };
        }
      }
    },
  );

  return DamLibrary.of({ execute });
});

export const layer = Layer.effect(DamLibrary, make);
