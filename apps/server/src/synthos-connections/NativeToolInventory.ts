import * as NativeToolProbes from "./NativeToolProbes.ts";
import type {
  SynthosNativeTool,
  SynthosNativeToolInventory,
  TerminalMetadataStreamEvent,
  TerminalSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as TerminalManager from "../terminal/Manager.ts";
import { nativeToolCatalog } from "./nativeToolCatalog.ts";

export class NativeToolInventory extends Context.Service<
  NativeToolInventory,
  {
    readonly list: (input: {
      readonly includeActivity: boolean;
    }) => Effect.Effect<SynthosNativeToolInventory>;
  }
>()("t3/synthos-connections/NativeToolInventory") {}

const noAccount = new Set([
  "ripgrep",
  "docling",
  "mermaid",
  "remotion",
  "blender",
  "gltf-transform",
  "ffmpeg",
  "voxcpm",
  "zonetimeline",
  "macmon",
  "bpytop",
  "backlog",
  "neo",
]);
const noConfiguration = new Set([
  "ripgrep",
  "ffmpeg",
  "blender",
  "zonetimeline",
  "macmon",
  "bpytop",
  "neo",
]);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const probes = yield* Effect.serviceOption(NativeToolProbes.NativeToolProbes);
  const terminalManager = yield* Effect.serviceOption(TerminalManager.TerminalManager);
  const delimiter = platform === "win32" ? ";" : ":";

  const readActivity = Effect.fn("NativeToolInventory.readActivity")(function* () {
    if (Option.isNone(terminalManager)) return null;
    const observed = new Map<string, TerminalSummary>();
    const listener = (event: TerminalMetadataStreamEvent) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          observed.clear();
          for (const terminal of event.terminals.slice(0, 500))
            observed.set(`${terminal.threadId}\0${terminal.terminalId}`, terminal);
        } else if (event.type === "remove")
          observed.delete(`${event.threadId}\0${event.terminalId}`);
        else if (
          observed.size < 500 ||
          observed.has(`${event.terminal.threadId}\0${event.terminal.terminalId}`)
        )
          observed.set(`${event.terminal.threadId}\0${event.terminal.terminalId}`, event.terminal);
      });
    return yield* Effect.acquireUseRelease(
      terminalManager.value.subscribeMetadata(listener),
      () => Effect.sync(() => [...observed.values()]),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
  });

  const list: NativeToolInventory["Service"]["list"] = Effect.fn("NativeToolInventory.list")(
    function* ({ includeActivity }) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const rawPath = environment.PATH ?? environment.Path ?? environment.path ?? "";
      const directories = [
        ...new Set(
          rawPath
            .slice(0, 32_768)
            .split(delimiter)
            .map((directory) => directory.trim().replace(/^"|"$/g, ""))
            .filter((directory) => path.isAbsolute(directory)),
        ),
      ].slice(0, 64);
      const lookupEnvironment = {
        PATH: directories.join(delimiter),
        ...(environment.PATHEXT ? { PATHEXT: environment.PATHEXT.slice(0, 256) } : {}),
      };
      const terminals = includeActivity ? yield* readActivity() : null;
      const tools = yield* Effect.forEach(
        nativeToolCatalog,
        Effect.fn("NativeToolInventory.inspect")(
          function* (tool): Effect.fn.Return<SynthosNativeTool> {
            const supported =
              (tool.platforms === undefined || tool.platforms.includes(platform)) &&
              (tool.architectures === undefined || tool.architectures.includes(architecture));
            const installed =
              supported &&
              tool.commandName !== null &&
              (yield* resolveCommandPath(tool.commandName, { env: lookupEnvironment }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              )) !== null;
            const configured =
              (tool.id === "github" || tool.id === "gh-dash") &&
              Boolean(environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim());
            const configuration = configured
              ? "configured"
              : noConfiguration.has(tool.id)
                ? "not_required"
                : "unknown";
            const activeTerminals =
              tool.commandName === null
                ? 0
                : (terminals ?? []).filter(
                    (terminal) =>
                      terminal.status === "running" &&
                      terminal.hasRunningSubprocess &&
                      terminal.label !== getTerminalLabel(terminal.terminalId) &&
                      (platform === "win32"
                        ? terminal.label.toLowerCase() === tool.commandName?.toLowerCase()
                        : terminal.label === tool.commandName),
                  ).length;
            const availability = !supported
              ? "unsupported"
              : tool.commandName === null
                ? "external"
                : installed
                  ? "installed"
                  : "missing";
            const probe = Option.isSome(probes)
              ? yield* probes.value.describe(tool.id).pipe(
                  Effect.orElseSucceed(() => ({
                    supported: false,
                    state: "unmeasured" as const,
                    scope: "cli_version" as const,
                    observation: null,
                  })),
                )
              : undefined;
            return {
              ...(probe ? { probe } : {}),
              id: tool.id,
              name: tool.name,
              description: tool.description,
              category: tool.category,
              interface: tool.interface,
              docs: tool.docs,
              commandName: tool.commandName,
              installed,
              configuration,
              authentication: noAccount.has(tool.id) ? "not_required" : "not_checked",
              availability,
              activity: activeTerminals > 0 ? "running" : "untracked",
              activeTerminals,
              handoff:
                installed && tool.handoff
                  ? { kind: "terminal", command: tool.handoff.join(" ") }
                  : null,
              reason: !supported
                ? "This host platform or architecture is unsupported."
                : tool.interface === "mcp"
                  ? "Remote MCP connection managed by your provider. Configuration, authentication, and tool activity are not inspected by this executable inventory."
                  : tool.commandName === null
                    ? "External application or service; no verified native CLI is tracked."
                    : !installed
                      ? "Executable was not found on this host's bounded PATH search."
                      : configured
                        ? "Credential configuration is present; authentication has not been checked."
                        : activeTerminals > 0
                          ? "A matching child process was observed in a T3 terminal."
                          : "Executable found. Setup and external terminal activity have not been verified.",
            };
          },
        ),
        { concurrency: 4 },
      );
      return { tools, checkedAt, activityObservedAt: terminals === null ? null : checkedAt };
    },
  );
  return NativeToolInventory.of({ list });
});

export const layer = Layer.effect(NativeToolInventory, make);
