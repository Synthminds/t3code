import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import * as ConnectionsConfig from "./ConnectionsConfig.ts";

it.effect("reads SYNTHOS_DAM_OWNER without ever failing the server", () =>
  Effect.gen(function* () {
    const codes: Array<unknown> = [];
    const logger = Logger.make(({ fiber, message }) => {
      codes.push(fiber.getRef(References.CurrentLogAnnotations).code, message);
    });
    const rows = [
      [undefined, "off"],
      ["", "off"],
      ["0", "off"],
      ["false", "off"],
      ["1", "on"],
      ["true", "on"],
      ["True", "on"],
      ["TRUE", "on"],
      [" 1", "on"],
      ["enabled", "unrecognized"],
    ] as const;
    for (const [value, expected] of rows) {
      const config = yield* ConnectionsConfig.ConnectionsConfig.pipe(
        Effect.provide(
          ConnectionsConfig.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnvRecord(
                  value === undefined ? {} : { SYNTHOS_DAM_OWNER: value },
                ),
              ),
            ),
            Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
          ),
        ),
      );
      expect([value, config.damOwner]).toEqual([value, expected]);
    }
    expect(codes[0]).toBe("DAM_OWNER_UNRECOGNIZED");
    expect(codes).toHaveLength(2);
    expect(JSON.stringify(codes)).not.toContain("enabled");
  }),
);
