// @effect-diagnostics-next-line nodeBuiltinImport:off -- Version probes execute fixed argv without a shell or provider calls.
import * as NodeChildProcess from "node:child_process";
import {
  SynthosConnectionError,
  SynthosToolProbe,
  type SynthosToolProbeStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { nativeToolCatalog } from "./nativeToolCatalog.ts";

const checks: Readonly<Record<string, readonly string[]>> = {
  github: ["--version"],
  ripgrep: ["--version"],
  playwright: ["--version"],
  docling: ["--version"],
  mermaid: ["--version"],
  blender: ["--version"],
  "gltf-transform": ["--version"],
  ffmpeg: ["-version"],
  bpytop: ["--version"],
  macmon: ["--version"],
};
interface RunResult {
  readonly reason: "completed" | "nonzero_exit" | "timeout" | "output_limit" | "spawn_failed";
  readonly exitCode: number | null;
  readonly outputBytes: number;
}
export class NativeProbeRunner extends Context.Service<
  NativeProbeRunner,
  {
    readonly run: (executable: string, args: readonly string[]) => Effect.Effect<RunResult>;
  }
>()("t3/synthos-connections/NativeToolProbes/NativeProbeRunner") {}
export class NativeToolProbes extends Context.Service<
  NativeToolProbes,
  {
    readonly probe: (toolId: string) => Effect.Effect<SynthosToolProbe, SynthosConnectionError>;
    readonly describe: (
      toolId: string,
    ) => Effect.Effect<SynthosToolProbeStatus, SynthosConnectionError>;
  }
>()("t3/synthos-connections/NativeToolProbes") {}
const encode = Schema.encodeEffect(Schema.fromJsonString(SynthosToolProbe));
const decode = Schema.decodeEffect(Schema.fromJsonString(SynthosToolProbe));
const storage = (cause: unknown) =>
  new SynthosConnectionError({ connection: "tools", reason: "storage", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const runner = yield* NativeProbeRunner;
  const permit = yield* Semaphore.make(1);
  const delimiter = platform === "win32" ? ";" : ":";
  const directories = [
    ...new Set(
      (environment.PATH ?? environment.Path ?? environment.path ?? "")
        .slice(0, 32768)
        .split(delimiter)
        .map((p) => p.trim().replace(/^"|"$/g, ""))
        .filter((p) => path.isAbsolute(p)),
    ),
  ].slice(0, 64);
  const inspect = Effect.fn("NativeToolProbes.inspect")(function* (toolId: string) {
    const tool = nativeToolCatalog.find((t) => t.id === toolId);
    const args = Object.hasOwn(checks, toolId) ? checks[toolId] : undefined;
    const supported = Boolean(
      tool &&
      args &&
      tool.commandName &&
      (tool.platforms === undefined || tool.platforms.includes(platform)) &&
      (tool.architectures === undefined || tool.architectures.includes(architecture)),
    );
    const executable =
      supported && tool?.commandName
        ? yield* resolveCommandPath(tool.commandName, {
            env: {
              PATH: directories.join(delimiter),
              ...(environment.PATHEXT ? { PATHEXT: environment.PATHEXT.slice(0, 256) } : {}),
            },
          }).pipe(
            Effect.provideService(CommandResolutionCache, new Map()),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
        : null;
    if (!executable) return { tool, args, supported, executable: null, fingerprint: null };
    const canonical = yield* fs.realPath(executable);
    const stat = yield* fs.stat(canonical);
    const identity = [
      platform,
      architecture,
      ...(args ?? []),
      canonical,
      String(stat.size),
      Option.getOrNull(stat.mtime)?.toISOString(),
      Option.getOrNull(stat.birthtime)?.toISOString(),
      Option.match(stat.ino, { onNone: () => "", onSome: String }),
      String(stat.dev),
    ];
    const fingerprint = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(identity.join("\n"))),
    );
    return { tool, args, supported, executable: canonical, fingerprint };
  }, Effect.mapError(storage));
  const describe = Effect.fn("NativeToolProbes.describe")(function* (toolId: string) {
    const current = yield* inspect(toolId);
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM synthos_tool_probes WHERE tool_id=${toolId}`.pipe(
      Effect.mapError(storage),
    );
    const observation = rows[0]
      ? yield* decode(rows[0].snapshot_json).pipe(Effect.mapError(storage))
      : null;
    const stale =
      observation !== null &&
      ((observation.reason === "unsupported") !== !current.supported ||
        observation.executableFingerprint !== current.fingerprint);
    return {
      supported: current.supported,
      state: stale ? ("stale" as const) : (observation?.state ?? ("unmeasured" as const)),
      scope: "cli_version" as const,
      observation,
    };
  });
  const probe = Effect.fn("NativeToolProbes.probe")(function* (toolId: string) {
    const current = yield* inspect(toolId);
    if (!current.tool)
      return yield* new SynthosConnectionError({ connection: "tools", reason: "invalid_input" });
    const outcome:
      | RunResult
      | { reason: "unsupported" | "missing"; exitCode: null; outputBytes: 0 } = !current.supported
      ? { reason: "unsupported", exitCode: null, outputBytes: 0 }
      : !current.executable || !current.args
        ? { reason: "missing", exitCode: null, outputBytes: 0 }
        : yield* runner.run(current.executable, current.args);
    const after = yield* inspect(toolId);
    const observation: SynthosToolProbe = {
      toolId,
      state:
        outcome.reason === "completed" && after.fingerprint === current.fingerprint
          ? "working"
          : "failed",
      scope: "cli_version",
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      executableFingerprint: current.fingerprint,
      reason: after.fingerprint !== current.fingerprint ? "spawn_failed" : outcome.reason,
      exitCode: outcome.exitCode,
      outputBytes: outcome.outputBytes,
    };
    const json = yield* encode(observation).pipe(Effect.mapError(storage));
    yield* sql`INSERT INTO synthos_tool_probes(tool_id,snapshot_json) VALUES (${toolId},${json}) ON CONFLICT(tool_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`.pipe(
      Effect.mapError(storage),
    );
    return observation;
  }, permit.withPermits(1));
  return NativeToolProbes.of({ probe, describe });
});
export const layer = Layer.effect(NativeToolProbes, make);
export const layerRunner = (
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number } = {
    timeoutMs: 5000,
    maxOutputBytes: 32768,
  },
) =>
  Layer.effect(
    NativeProbeRunner,
    Effect.gen(function* () {
      const inherited = yield* HostProcess.Environment;
      const environment: NodeJS.ProcessEnv = {};
      for (const key of [
        "PATH",
        "Path",
        "PATHEXT",
        "SystemRoot",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "TMP",
      ])
        if (inherited[key] !== undefined) environment[key] = inherited[key];
      environment.GH_PROMPT_DISABLED = "1";
      environment.NO_COLOR = "1";
      const run = Effect.fn("NativeProbeRunner.run")(function* (
        executable: string,
        args: readonly string[],
      ) {
        return yield* Effect.promise(
          (signal) =>
            new Promise<RunResult>((resolve) => {
              NodeChildProcess.execFile(
                executable,
                [...args],
                {
                  encoding: "buffer",
                  timeout: limits.timeoutMs,
                  maxBuffer: limits.maxOutputBytes,
                  killSignal: "SIGKILL",
                  windowsHide: true,
                  env: environment,
                  signal,
                },
                (error, stdout, stderr) => {
                  const outputBytes = Math.min(
                    stdout.byteLength + stderr.byteLength,
                    limits.maxOutputBytes * 2,
                  );
                  if (!error) return resolve({ reason: "completed", exitCode: 0, outputBytes });
                  const reason =
                    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                      ? "output_limit"
                      : error.killed || error.name === "AbortError"
                        ? "timeout"
                        : typeof error.code === "number"
                          ? "nonzero_exit"
                          : "spawn_failed";
                  resolve({
                    reason,
                    exitCode: typeof error.code === "number" ? error.code : null,
                    outputBytes,
                  });
                },
              );
            }),
        );
      });
      return NativeProbeRunner.of({ run });
    }),
  );
