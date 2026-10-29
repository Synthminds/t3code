// @effect-diagnostics nodeBuiltinImport:off - Real temporary symlink and hardlink fixtures exercise the Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ObsidianVault from "./ObsidianVault.ts";

const temporaryVault = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-obsidian-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

it.effect("requires configured vault access", () =>
  Effect.gen(function* () {
    const vault = yield* ObsidianVault.ObsidianVault;
    const error = yield* vault.read({ path: "note.md" }).pipe(Effect.flip);
    expect(error._tag).toBe("ObsidianVaultUnavailableError");
  }).pipe(Effect.provide(ObsidianVault.layer({}))),
);

it.effect("creates nested notes and rejects conflicting writes", () =>
  Effect.gen(function* () {
    const root = yield* temporaryVault;
    yield* Effect.gen(function* () {
      const vault = yield* ObsidianVault.ObsidianVault;
      const path = "GCH/Missions/note.md";
      const created = yield* vault.write({
        path,
        content: "# Original\nText",
        expectedVersion: null,
      });
      expect(yield* vault.read({ path })).toEqual(created);
      expect(
        (yield* vault
          .write({ path, content: "Overwrite", expectedVersion: null })
          .pipe(Effect.flip))._tag,
      ).toBe("ObsidianVaultConflictError");
      const saved = yield* vault.write({
        path,
        content: "# New",
        expectedVersion: created.version,
      });
      expect(saved.version).not.toBe(created.version);
      const conflict = yield* vault
        .write({ path, content: "Stale", expectedVersion: created.version })
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "ObsidianVaultConflictError",
        currentVersion: saved.version,
      });
      expect((yield* vault.read({ path })).content).toBe("# New");
    }).pipe(Effect.provide(ObsidianVault.layer({ vaultRoot: root })));
  }),
);

it.effect("serializes competing writes with the same expected version", () =>
  Effect.gen(function* () {
    const root = yield* temporaryVault;
    yield* Effect.gen(function* () {
      const vault = yield* ObsidianVault.ObsidianVault;
      const created = yield* vault.write({
        path: "note.md",
        content: "Original",
        expectedVersion: null,
      });
      const results = yield* Effect.forEach(
        ["First", "Second"],
        (content) =>
          vault
            .write({ path: "note.md", content, expectedVersion: created.version })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
    }).pipe(Effect.provide(ObsidianVault.layer({ vaultRoot: root })));
  }),
);

it.effect("rejects traversal, hidden paths, symlinks, hard links and non-markdown files", () =>
  Effect.gen(function* () {
    const root = yield* temporaryVault;
    const outside = yield* temporaryVault;
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(NodePath.join(outside, "secret.md"), "private");
      await NodeFSP.symlink(outside, NodePath.join(root, "linked-directory"));
      await NodeFSP.symlink(NodePath.join(outside, "secret.md"), NodePath.join(root, "linked.md"));
      await NodeFSP.link(NodePath.join(outside, "secret.md"), NodePath.join(root, "hard.md"));
    });
    yield* Effect.gen(function* () {
      const vault = yield* ObsidianVault.ObsidianVault;
      for (const path of [
        "../secret.md",
        "/secret.md",
        "folder\\secret.md",
        ".obsidian/config.md",
        "note.txt",
        "linked.md",
        "linked-directory/secret.md",
        "hard.md",
      ]) {
        expect((yield* vault.read({ path }).pipe(Effect.flip))._tag).toBe(
          "ObsidianVaultValidationError",
        );
        expect(
          (yield* vault
            .write({ path, content: "Changed", expectedVersion: "0".repeat(64) })
            .pipe(Effect.flip))._tag,
        ).toBe("ObsidianVaultValidationError");
      }
      expect(
        yield* vault
          .write({
            path: "linked-directory/new/created.md",
            content: "Must stay inside the vault",
            expectedVersion: null,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ObsidianVaultValidationError", reason: "symlink" });
    }).pipe(Effect.provide(ObsidianVault.layer({ vaultRoot: root })));
    expect(yield* Effect.promise(() => NodeFSP.readdir(outside))).toEqual(["secret.md"]);
    expect(
      yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(outside, "secret.md"), "utf8")),
    ).toBe("private");
    yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(root, "root-link")));
    const error = yield* Effect.gen(function* () {
      return yield* (yield* ObsidianVault.ObsidianVault)
        .read({ path: "secret.md" })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(ObsidianVault.layer({ vaultRoot: NodePath.join(root, "root-link") })));
    expect(error._tag).toBe("ObsidianVaultValidationError");
  }),
);

it.effect("bounds content by UTF-8 bytes and lists only visible Markdown paths", () =>
  Effect.gen(function* () {
    const root = yield* temporaryVault;
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.join(root, "projects"));
      await NodeFSP.mkdir(NodePath.join(root, ".obsidian"));
      await NodeFSP.writeFile(NodePath.join(root, "projects", "Alpha.md"), "# Alpha");
      await NodeFSP.writeFile(NodePath.join(root, "Beta.md"), "# Beta");
      await NodeFSP.writeFile(NodePath.join(root, ".obsidian", "Hidden.md"), "hidden");
      await NodeFSP.writeFile(NodePath.join(root, "binary.txt"), "not a note");
      await NodeFSP.writeFile(NodePath.join(root, "huge.md"), "x".repeat(200_001));
      await NodeFSP.symlink(NodePath.join(root, "projects"), NodePath.join(root, "duplicate"));
    });
    yield* Effect.gen(function* () {
      const vault = yield* ObsidianVault.ObsidianVault;
      expect(yield* vault.read({ path: "huge.md" }).pipe(Effect.flip)).toMatchObject({
        reason: "too-large",
      });
      expect(
        yield* vault
          .write({ path: "unicode.md", content: "é".repeat(100_001), expectedVersion: null })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "too-large" });
      expect(yield* vault.list({ query: "alpha" })).toEqual({
        notes: [{ path: "projects/Alpha.md", title: "Alpha" }],
        truncated: false,
      });
      expect(yield* vault.list({ limit: 1 })).toMatchObject({
        notes: [{ path: "Beta.md", title: "Beta" }],
        truncated: true,
      });
    }).pipe(Effect.provide(ObsidianVault.layer({ vaultRoot: root })));
  }),
);
