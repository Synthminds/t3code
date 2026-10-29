import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { TOKEN_MONITOR_EXPORT_MAX_BYTES } from "@t3tools/shared/tokenMonitorExport";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as TokenMonitorExportReader from "./TokenMonitorExportReader.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    TokenMonitorExportReader.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
)("Token Monitor local export", (it) => {
  it.effect("reads only the selected export and preserves absent usage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const reader = yield* TokenMonitorExportReader.TokenMonitorExportReader;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-monitor-export-" });
      const path = `${root}/export.json`;
      const body = JSON.stringify({
        app: { name: "token-monitor", version: "0.80.0" },
        generatedAt: "2026-10-28T12:00:00.000Z",
        snapshot: { today: { totalTokens: 0 } },
      });
      yield* fs.writeFileString(path, body);
      const report = yield* reader.read(path);
      assert.equal(report.periods.today.totalTokens, 0);
      assert.equal(report.periods.allTime.totalTokens, null);
      assert.equal(yield* fs.readFileString(path), body);
    }),
  );

  it.effect("rejects directories, oversized exports, and malformed UTF-8", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const reader = yield* TokenMonitorExportReader.TokenMonitorExportReader;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-monitor-invalid-" });
      assert.include((yield* Effect.flip(reader.read(root))).message, "regular");
      const path = `${root}/export.json`;
      yield* fs.writeFileString(path, " ".repeat(TOKEN_MONITOR_EXPORT_MAX_BYTES + 1));
      assert.include((yield* Effect.flip(reader.read(path))).message, "2 MiB");
      yield* fs.writeFile(path, new Uint8Array([0xff, 0xfe]));
      assert.include((yield* Effect.flip(reader.read(path))).message, "UTF-8");
    }),
  );
});
