import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLI_RELEASE_CHANNELS,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { launcherOwnsVersionsDir, windowsShimTarget } from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags } from "./config.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

export const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    );
    const authenticatedRequest =
      githubToken === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
    const body = yield* httpClient.execute(authenticatedRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(() => new CliUpdateError({ reason: "Could not list t3 releases." })),
      Effect.timeoutOrElse({
        duration: RELEASE_INDEX_TIMEOUT,
        orElse: () => Effect.fail(new CliUpdateError({ reason: "Timed out listing t3 releases." })),
      }),
    );
    const releases = yield* decodeReleaseIndex(body).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: "The t3 release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
});

/**
 * Only a launcher that already points into this home's `runtime/versions` tree is touched; a
 * plain copy of the executable, or a launcher for some other install, is left alone.
 */
export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
  readonly targetEntryPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return Option.none<string>();
  const ownsTarget = (candidate: string) =>
    launcherOwnsVersionsDir(path, input.versionsDir, candidate);

  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return Option.none<string>();
    const current = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const quoted = Option.isSome(current) ? windowsShimTarget(current.value) : undefined;
    if (quoted === undefined || !ownsTarget(quoted)) return Option.none<string>();
    yield* fs
      .writeFileString(shimPath, `@echo off\r\n"${input.targetEntryPath}" %*`)
      .pipe(
        Effect.mapError(
          () => new CliUpdateError({ reason: `Could not rewrite the t3 launcher at ${shimPath}.` }),
        ),
      );
    return Option.some(shimPath);
  }

  const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
  if (Option.isNone(linkTarget)) return Option.none<string>();
  const resolvedTarget = path.resolve(path.dirname(input.launchedAs), linkTarget.value);
  if (!ownsTarget(resolvedTarget)) return Option.none<string>();
  const tempLink = `${input.launchedAs}.${process.pid}.tmp`;
  yield* fs.symlink(input.targetEntryPath, tempLink).pipe(
    Effect.andThen(fs.rename(tempLink, input.launchedAs)),
    Effect.mapError(
      () =>
        new CliUpdateError({ reason: `Could not repoint the t3 launcher at ${input.launchedAs}.` }),
    ),
  );
  return Option.some(input.launchedAs);
});

/** Node preserves argv0's spelling; resolve bare names on PATH to find the launcher symlink. */
export const resolveLauncherPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const invokedAs = yield* HostProcess.InvokedAs;
  const cwd = yield* HostProcess.WorkingDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  if (invokedAs.includes("/") || invokedAs.includes("\\")) {
    return path.resolve(cwd, invokedAs);
  }
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, invokedAs);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return undefined;
});

/** Windows executables see their own path, so find the installer shim by matching t3.cmd targets on PATH. */
export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const candidates = [
    ...(environment["T3CODE_INSTALL_BIN_DIR"] ? [environment["T3CODE_INSTALL_BIN_DIR"]] : []),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
  ].filter((entry) => entry.trim().length > 0);
  for (const directory of candidates) {
    const shimPath = path.join(directory, "t3.cmd");
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const target = windowsShimTarget(contents.value);
    if (
      target !== undefined &&
      path.resolve(target).toLowerCase() === path.resolve(executablePath).toLowerCase()
    ) {
      return shimPath;
    }
  }
  return undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription(
      "Release channel to follow. Defaults to the channel this t3 was published on.",
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow moving to an older version than the one running."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Restart the background service without asking. Required to restart it from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription(
    "Exact version to install. Defaults to the newest release on the channel.",
  ),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription("SynthOS updates are manual; upstream T3 installation is disabled."),
  Command.withHandler(() =>
    Effect.fail(
      new CliUpdateError({
        reason:
          "Automatic updates are disabled for SynthOS. Rebuild the reviewed fork checkout and restart its source service; upstream T3 binaries are not compatible with this fork.",
      }),
    ),
  ),
);
