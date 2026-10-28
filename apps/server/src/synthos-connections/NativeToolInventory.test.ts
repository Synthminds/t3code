import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { TerminalSummary } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as TerminalManager from "../terminal/Manager.ts";
import * as NativeToolInventory from "./NativeToolInventory.ts";

it.effect(
  "discovers 41 tools without launching them and keeps configuration separate from authentication",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synthos-tools-" });
      for (const command of ["gh", "rg", "Raijin", "gloomberb", "gch-librechat", "macmon"]) {
        const executable = path.join(root, command);
        yield* fileSystem.writeFileString(executable, "#!/bin/sh\nexit 99\n");
        yield* fileSystem.chmod(executable, 0o700);
      }
      yield* Effect.gen(function* () {
        const inventory = yield* NativeToolInventory.NativeToolInventory;
        const snapshot = yield* inventory.list({ includeActivity: true });
        expect(snapshot.tools).toHaveLength(41);
        expect(new Set(snapshot.tools.map((tool) => tool.id)).size).toBe(41);
        expect(snapshot.tools.find((tool) => tool.id === "github")).toMatchObject({
          installed: true,
          configuration: "configured",
          authentication: "not_checked",
          activity: "untracked",
          activeTerminals: 0,
        });
        expect(snapshot.tools.find((tool) => tool.id === "ripgrep")).toMatchObject({
          installed: true,
          configuration: "not_required",
          authentication: "not_required",
          activity: "untracked",
        });
        expect(snapshot.tools.find((tool) => tool.id === "firecrawl")).toMatchObject({
          installed: false,
          availability: "missing",
          configuration: "unknown",
          authentication: "not_checked",
          handoff: null,
        });
        expect(snapshot.tools.find((tool) => tool.id === "raijin")).toMatchObject({
          installed: true,
          handoff: { kind: "terminal", command: "Raijin" },
        });
        expect(snapshot.tools.find((tool) => tool.id === "macmon")).toMatchObject({
          installed: false,
          availability: "unsupported",
        });
        expect(snapshot.tools.find((tool) => tool.id === "librechat")).toMatchObject({
          availability: "external",
          installed: false,
          commandName: null,
          handoff: null,
        });
        expect(snapshot.activityObservedAt).toBeNull();
        expect(JSON.stringify(snapshot)).not.toContain("private-token");
        expect(JSON.stringify(snapshot)).not.toContain(root);
      }).pipe(
        Effect.provide(NativeToolInventory.layer),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${root}:relative-path`,
          GH_TOKEN: "private-token",
        }),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "lights only an observed matching T3 child process and releases the metadata subscription",
  () => {
    let subscriptions = 0;
    let releases = 0;
    const terminal = (
      input: Pick<TerminalSummary, "terminalId" | "label" | "status" | "hasRunningSubprocess">,
    ): TerminalSummary => ({
      threadId: "thread",
      cwd: "/private",
      worktreePath: null,
      pid: 20,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-10-28T12:00:00Z",
      ...input,
    });
    const metadata = [
      terminal({
        terminalId: "term-1",
        label: "gh",
        status: "running",
        hasRunningSubprocess: true,
      }),
      terminal({ terminalId: "rg", label: "rg", status: "running", hasRunningSubprocess: true }),
      terminal({
        terminalId: "term-3",
        label: "ffmpeg",
        status: "exited",
        hasRunningSubprocess: false,
      }),
    ];
    const manager = Layer.succeed(TerminalManager.TerminalManager, {
      subscribeMetadata: (listener) =>
        Effect.gen(function* () {
          subscriptions += 1;
          yield* listener({ type: "snapshot", terminals: metadata });
          return () => {
            releases += 1;
          };
        }),
    } as TerminalManager.TerminalManager["Service"]);
    return Effect.gen(function* () {
      const inventory = yield* NativeToolInventory.NativeToolInventory;
      const redacted = yield* inventory.list({ includeActivity: false });
      expect(redacted.activityObservedAt).toBeNull();
      expect(subscriptions).toBe(0);
      const snapshot = yield* inventory.list({ includeActivity: true });
      expect(snapshot.tools.find((tool) => tool.id === "github")).toMatchObject({
        activity: "running",
        activeTerminals: 1,
      });
      expect(snapshot.tools.find((tool) => tool.id === "ripgrep")).toMatchObject({
        activity: "untracked",
        activeTerminals: 0,
      });
      expect(snapshot.tools.find((tool) => tool.id === "ffmpeg")).toMatchObject({
        activity: "untracked",
        activeTerminals: 0,
      });
      expect(snapshot.activityObservedAt).not.toBeNull();
      expect(subscriptions).toBe(1);
      expect(releases).toBe(1);
      metadata.splice(0, 1);
      expect(
        (yield* inventory.list({ includeActivity: true })).tools.find(
          (tool) => tool.id === "github",
        )?.activity,
      ).toBe("untracked");
      expect(releases).toBe(2);
    }).pipe(
      Effect.provide(NativeToolInventory.layer.pipe(Layer.provide(manager))),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
      Effect.provide(NodeServices.layer),
    );
  },
);
