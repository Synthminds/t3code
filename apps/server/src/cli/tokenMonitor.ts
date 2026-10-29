import { tokenMonitorExportSummary } from "@t3tools/shared/tokenMonitorExport";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import * as TokenMonitorExportReader from "../synthos/TokenMonitorExportReader.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const tokenMonitorCommand = Command.make("usage-import", {
  file: Argument.String("file").pipe(
    Argument.withDescription("Official token-monitor-export.json, at most 2 MiB."),
  ),
}).pipe(
  Command.withDescription(
    "Read a local Token Monitor export and print an advisory usage summary. No accounts, network, or budget changes.",
  ),
  Command.withHandler(({ file }) =>
    Effect.gen(function* () {
      const reader = yield* TokenMonitorExportReader.TokenMonitorExportReader;
      const report = yield* reader.read(file);
      yield* Console.log(encodeJson(tokenMonitorExportSummary(report)));
    }).pipe(
      Effect.provide(TokenMonitorExportReader.layer),
      Effect.tapError((error) => Console.error(error.message)),
    ),
  ),
);
