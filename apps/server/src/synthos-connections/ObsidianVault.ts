// @effect-diagnostics nodeBuiltinImport:off - This Node filesystem adapter needs no-follow file handles, inode checks, and byte hashing together.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const MAX_NOTE_BYTES = 200_000;
const MAX_SCAN_ENTRIES = 1_000;

export class ObsidianVaultUnavailableError extends Schema.TaggedError<ObsidianVaultUnavailableError>()(
  "ObsidianVaultUnavailableError",
  { reason: Schema.Literals(["not-configured", "unsupported-filesystem"]) },
) {
  override get message(): string {
    return this.reason === "not-configured"
      ? "Configure an Obsidian vault on the server before using this connection."
      : "This filesystem does not support safe no-follow vault access.";
  }
}

export class ObsidianVaultValidationError extends Schema.TaggedError<ObsidianVaultValidationError>()(
  "ObsidianVaultValidationError",
  {
    reason: Schema.Literals([
      "relative-path",
      "markdown-only",
      "hidden-path",
      "symlink",
      "not-regular-file",
      "too-large",
      "unsafe-root",
      "invalid-query",
      "invalid-version",
      "concurrent-change",
    ]),
  },
) {
  override get message(): string {
    const messages = {
      "relative-path": "Choose a relative path inside the configured vault.",
      "markdown-only": "Only Markdown notes can be accessed through this connection.",
      "hidden-path": "Hidden vault paths cannot be accessed through this connection.",
      symlink: "Vault access does not follow symbolic links.",
      "not-regular-file": "Vault notes must be regular files with a single link.",
      "too-large": "The note exceeds the 200,000 byte limit.",
      "unsafe-root":
        "The configured vault must be an existing absolute directory without symbolic links.",
      "invalid-query": "Use a query of at most 500 characters and a limit between 1 and 100.",
      "invalid-version": "An existing note requires its current SHA-256 version.",
      "concurrent-change":
        "The note or vault path changed during access. Read it again before retrying.",
    };
    return messages[this.reason];
  }
}

export class ObsidianVaultConflictError extends Schema.TaggedError<ObsidianVaultConflictError>()(
  "ObsidianVaultConflictError",
  { currentVersion: Schema.NullOr(Schema.String) },
) {
  override get message(): string {
    return "The note changed since it was read. Review the current version before saving.";
  }
}

export class ObsidianVaultIoError extends Schema.TaggedError<ObsidianVaultIoError>()(
  "ObsidianVaultIoError",
  {
    operation: Schema.Literals(["read", "write", "list"]),
    category: Schema.Literals(["not-found", "permission-denied", "filesystem"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Obsidian ${this.operation} failed (${this.category}).`;
  }
}

type VaultError =
  | ObsidianVaultUnavailableError
  | ObsidianVaultValidationError
  | ObsidianVaultConflictError
  | ObsidianVaultIoError;
const isVaultError = Schema.is(
  Schema.Union([
    ObsidianVaultUnavailableError,
    ObsidianVaultValidationError,
    ObsidianVaultConflictError,
    ObsidianVaultIoError,
  ]),
);
type Note = { readonly path: string; readonly content: string; readonly version: string };

export class ObsidianVault extends Context.Service<
  ObsidianVault,
  {
    readonly read: (input: { readonly path: string }) => Effect.Effect<Note, VaultError>;
    readonly write: (input: {
      readonly path: string;
      readonly content: string;
      readonly expectedVersion: string | null;
    }) => Effect.Effect<Note, VaultError>;
    readonly list: (input?: { readonly query?: string; readonly limit?: number }) => Effect.Effect<
      {
        readonly notes: ReadonlyArray<{ readonly path: string; readonly title: string }>;
        readonly truncated: boolean;
      },
      VaultError
    >;
  }
>()("t3/synthos-connections/ObsidianVault") {}

function versionOf(content: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}

function ioError(operation: ObsidianVaultIoError["operation"], cause: unknown): VaultError {
  if (isVaultError(cause)) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  if (code === "ELOOP") return new ObsidianVaultValidationError({ reason: "symlink" });
  return new ObsidianVaultIoError({
    operation,
    category:
      code === "ENOENT"
        ? "not-found"
        : code === "EACCES" || code === "EPERM"
          ? "permission-denied"
          : "filesystem",
    cause,
  });
}

function validatePath(path: string): string[] {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    /[\\\x00-\x1f:]/.test(path) ||
    NodePath.isAbsolute(path)
  ) {
    throw new ObsidianVaultValidationError({ reason: "relative-path" });
  }
  const segments = path.split("/");
  if (
    segments.some(
      (part) =>
        part === "" || part === "." || part === ".." || part.trim() !== part || /[. ]$/.test(part),
    )
  ) {
    throw new ObsidianVaultValidationError({ reason: "relative-path" });
  }
  if (segments.some((part) => part.startsWith("."))) {
    throw new ObsidianVaultValidationError({ reason: "hidden-path" });
  }
  if (NodePath.extname(path).toLowerCase() !== ".md") {
    throw new ObsidianVaultValidationError({ reason: "markdown-only" });
  }
  return segments;
}

async function verifyDirectory(path: string): Promise<void> {
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink()) throw new ObsidianVaultValidationError({ reason: "symlink" });
  if (!stat.isDirectory()) throw new ObsidianVaultValidationError({ reason: "unsafe-root" });
}

async function rootDirectory(vaultRoot: string | undefined): Promise<string> {
  if (!vaultRoot?.trim()) throw new ObsidianVaultUnavailableError({ reason: "not-configured" });
  if (NodeFS.constants.O_NOFOLLOW === undefined) {
    throw new ObsidianVaultUnavailableError({ reason: "unsupported-filesystem" });
  }
  if (!NodePath.isAbsolute(vaultRoot))
    throw new ObsidianVaultValidationError({ reason: "unsafe-root" });
  const root = NodePath.resolve(vaultRoot);
  let directory = NodePath.parse(root).root;
  for (const segment of root.slice(directory.length).split(NodePath.sep).filter(Boolean)) {
    directory = NodePath.join(directory, segment);
    await verifyDirectory(directory);
  }
  if ((await NodeFSP.realpath(root)) !== root)
    throw new ObsidianVaultValidationError({ reason: "unsafe-root" });
  return root;
}

async function resolveTarget(
  root: string,
  segments: string[],
  createParents = false,
): Promise<string> {
  let parent = root;
  await verifyDirectory(root);
  for (const segment of segments.slice(0, -1)) {
    parent = NodePath.join(parent, segment);
    if (createParents) {
      // Create one level at a time so every parent is checked before descending.
      // A pre-existing symlink must not be followed by a recursive mkdir.
      await NodeFSP.mkdir(parent, { mode: 0o700 }).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EEXIST") throw cause;
      });
    }
    await verifyDirectory(parent);
  }
  if ((await NodeFSP.realpath(parent)) !== parent)
    throw new ObsidianVaultValidationError({ reason: "symlink" });
  return NodePath.join(root, ...segments);
}

async function verifyFile(handle: NodeFSP.FileHandle, target: string): Promise<NodeFS.Stats> {
  const [opened, current] = await Promise.all([handle.stat(), NodeFSP.lstat(target)]);
  if (current.isSymbolicLink()) throw new ObsidianVaultValidationError({ reason: "symlink" });
  if (!opened.isFile() || !current.isFile() || opened.nlink !== 1 || current.nlink !== 1) {
    throw new ObsidianVaultValidationError({ reason: "not-regular-file" });
  }
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new ObsidianVaultValidationError({ reason: "concurrent-change" });
  }
  if (opened.size > MAX_NOTE_BYTES) throw new ObsidianVaultValidationError({ reason: "too-large" });
  return opened;
}

async function readHandle(handle: NodeFSP.FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_NOTE_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const result = await handle.read(bytes, length, bytes.length - length, length);
    if (result.bytesRead === 0) break;
    length += result.bytesRead;
  }
  if (length > MAX_NOTE_BYTES) throw new ObsidianVaultValidationError({ reason: "too-large" });
  return bytes.subarray(0, length);
}

const make = Effect.fn("ObsidianVault.make")(function* (config: { readonly vaultRoot?: string }) {
  const writes = yield* Semaphore.make(1);
  const read: ObsidianVault["Service"]["read"] = Effect.fn("ObsidianVault.read")((input) =>
    Effect.tryPromise({
      try: async () => {
        const segments = validatePath(input.path);
        const root = await rootDirectory(config.vaultRoot);
        const target = await resolveTarget(root, segments);
        const handle = await NodeFSP.open(
          target,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        try {
          const before = await verifyFile(handle, target);
          await resolveTarget(root, segments);
          const bytes = await readHandle(handle);
          const after = await verifyFile(handle, target);
          if (
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            before.size !== after.size
          ) {
            throw new ObsidianVaultValidationError({ reason: "concurrent-change" });
          }
          return { path: input.path, content: bytes.toString("utf8"), version: versionOf(bytes) };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => ioError("read", cause),
    }),
  );

  const write: ObsidianVault["Service"]["write"] = Effect.fn("ObsidianVault.write")(
    (input) =>
      Effect.tryPromise({
        try: async () => {
          const segments = validatePath(input.path);
          if (Buffer.byteLength(input.content, "utf8") > MAX_NOTE_BYTES) {
            throw new ObsidianVaultValidationError({ reason: "too-large" });
          }
          if (input.expectedVersion !== null && !/^[a-f0-9]{64}$/.test(input.expectedVersion)) {
            throw new ObsidianVaultValidationError({ reason: "invalid-version" });
          }
          const root = await rootDirectory(config.vaultRoot);
          const target = await resolveTarget(root, segments, input.expectedVersion === null);
          const flags =
            NodeFS.constants.O_RDWR |
            NodeFS.constants.O_NOFOLLOW |
            NodeFS.constants.O_NONBLOCK |
            (input.expectedVersion === null
              ? NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL
              : 0);
          const handle = await NodeFSP.open(target, flags, 0o600).catch(
            (cause: NodeJS.ErrnoException) => {
              if (
                cause.code === "EEXIST" ||
                (cause.code === "ENOENT" && input.expectedVersion !== null)
              ) {
                throw new ObsidianVaultConflictError({ currentVersion: null });
              }
              throw cause;
            },
          );
          try {
            const before = await verifyFile(handle, target);
            await resolveTarget(root, segments);
            const currentVersion = versionOf(await readHandle(handle));
            if (input.expectedVersion !== null && input.expectedVersion !== currentVersion) {
              throw new ObsidianVaultConflictError({ currentVersion });
            }
            const checked = await verifyFile(handle, target);
            if (
              before.mtimeMs !== checked.mtimeMs ||
              before.ctimeMs !== checked.ctimeMs ||
              before.size !== checked.size
            ) {
              throw new ObsidianVaultValidationError({ reason: "concurrent-change" });
            }
            // External editors do not share this lock; the hash precondition is optimistic, not a filesystem CAS.
            await handle.writeFile(input.content, "utf8");
            await handle.truncate(Buffer.byteLength(input.content, "utf8"));
            await handle.sync();
            await resolveTarget(root, segments);
            await verifyFile(handle, target);
            const version = versionOf(input.content);
            if (versionOf(await readHandle(handle)) !== version) {
              throw new ObsidianVaultValidationError({ reason: "concurrent-change" });
            }
            return { path: input.path, content: input.content, version };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) => ioError("write", cause),
      }),
    Effect.uninterruptible,
    writes.withPermit,
  );

  const list: ObsidianVault["Service"]["list"] = Effect.fn("ObsidianVault.list")((input = {}) =>
    Effect.tryPromise({
      try: async () => {
        const query = input.query?.trim().toLowerCase() ?? "";
        const limit = input.limit ?? 50;
        if (query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ObsidianVaultValidationError({ reason: "invalid-query" });
        }
        const root = await rootDirectory(config.vaultRoot);
        const candidates: Array<{ path: string; title: string }> = [];
        const pending = [""];
        let scanned = 0;
        let truncated = false;
        while (pending.length > 0 && scanned < MAX_SCAN_ENTRIES) {
          const directory = pending.shift()!;
          const segments = directory ? directory.split("/") : [];
          const absolute = await resolveTarget(root, [...segments, "placeholder.md"]);
          const entries = await NodeFSP.opendir(NodePath.dirname(absolute));
          for await (const entry of entries) {
            if (++scanned > MAX_SCAN_ENTRIES) {
              truncated = true;
              break;
            }
            if (
              entry.name.startsWith(".") ||
              entry.name.trim() !== entry.name ||
              /[\\\x00-\x1f:]/.test(entry.name) ||
              /[. ]$/.test(entry.name)
            )
              continue;
            const path = directory ? `${directory}/${entry.name}` : entry.name;
            if (path.length > 1_024) continue;
            const stat = await NodeFSP.lstat(NodePath.join(root, path));
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
              if (segments.length < 12) pending.push(path);
              else truncated = true;
            } else if (
              stat.isFile() &&
              stat.nlink === 1 &&
              NodePath.extname(path).toLowerCase() === ".md"
            ) {
              if (path.toLowerCase().includes(query)) {
                candidates.push({ path, title: NodePath.basename(path, NodePath.extname(path)) });
              }
            }
          }
          await resolveTarget(root, [...segments, "placeholder.md"]);
        }
        candidates.sort((left, right) => left.path.localeCompare(right.path));
        return {
          notes: candidates.slice(0, limit),
          truncated: truncated || pending.length > 0 || candidates.length > limit,
        };
      },
      catch: (cause) => ioError("list", cause),
    }),
  );
  return ObsidianVault.of({ read, write, list });
});

export const layer = (config: { readonly vaultRoot?: string }) =>
  Layer.effect(ObsidianVault, make(config));
