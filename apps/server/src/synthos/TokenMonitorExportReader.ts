import {
  parseTokenMonitorExport,
  TOKEN_MONITOR_EXPORT_MAX_BYTES,
  TokenMonitorExportError,
} from "@t3tools/shared/tokenMonitorExport";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

export class TokenMonitorReadError extends Schema.TaggedError<TokenMonitorReadError>()(
  "TokenMonitorReadError",
  { reason: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return this.reason;
  }
}

export class TokenMonitorExportReader extends Context.Service<
  TokenMonitorExportReader,
  {
    readonly read: (
      path: string,
    ) => Effect.Effect<ReturnType<typeof parseTokenMonitorExport>, TokenMonitorReadError>;
  }
>()("t3/synthos/TokenMonitorExportReader") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const unreadable = () =>
    new TokenMonitorReadError({
      reason: "Choose a readable regular Token Monitor JSON export file.",
    });
  const tooLarge = () =>
    new TokenMonitorReadError({ reason: "Token Monitor exports must be at most 2 MiB." });
  const read = Effect.fn("TokenMonitorExportReader.read")(function* (path: string) {
    const info = yield* fs.stat(path).pipe(Effect.mapError(unreadable));
    if (info.type !== "File") return yield* unreadable();
    if (info.size > BigInt(TOKEN_MONITOR_EXPORT_MAX_BYTES)) return yield* tooLarge();
    const file = yield* fs.open(path, { flag: "r" }).pipe(Effect.mapError(unreadable));
    const opened = yield* file.stat.pipe(Effect.mapError(unreadable));
    if (opened.type !== "File") return yield* unreadable();
    if (opened.size > BigInt(TOKEN_MONITOR_EXPORT_MAX_BYTES)) return yield* tooLarge();
    const buffer = new Uint8Array(TOKEN_MONITOR_EXPORT_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = yield* file.read(buffer.subarray(size)).pipe(Effect.mapError(unreadable));
      if (count === 0) break;
      size += count;
    }
    if (size > TOKEN_MONITOR_EXPORT_MAX_BYTES) return yield* tooLarge();
    return yield* Effect.try({
      try: () =>
        parseTokenMonitorExport(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
        ),
      catch: (error) =>
        new TokenMonitorReadError({
          reason:
            error instanceof TokenMonitorExportError
              ? error.message
              : "The export must contain valid UTF-8 JSON.",
        }),
    });
  }, Effect.scoped);
  return TokenMonitorExportReader.of({ read });
});

export const layer = Layer.effect(TokenMonitorExportReader, make);
