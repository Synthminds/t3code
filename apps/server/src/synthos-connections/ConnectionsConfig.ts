import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export class ConnectionsConfig extends Context.Service<
  ConnectionsConfig,
  {
    readonly agentMailKey: Redacted.Redacted<string> | undefined;
    readonly memKey: Redacted.Redacted<string> | undefined;
    readonly obsidianVaultRoot: string | undefined;
  }
>()("t3/synthos-connections/ConnectionsConfig") {}

export const layer = Layer.effect(
  ConnectionsConfig,
  Effect.gen(function* () {
    const agentMailKey = yield* Config.Redacted("AGENTMAIL_API_KEY").pipe(Config.option);
    const memKey = yield* Config.Redacted("MEM_API_KEY").pipe(Config.option);
    const obsidianVaultRoot = yield* Config.String("SYNTHOS_OBSIDIAN_VAULT_ROOT").pipe(
      Config.option,
    );
    return ConnectionsConfig.of({
      agentMailKey: Option.getOrUndefined(
        Option.filter(agentMailKey, (key) => Redacted.value(key).trim().length > 0),
      ),
      memKey: Option.getOrUndefined(
        Option.filter(memKey, (key) => Redacted.value(key).trim().length > 0),
      ),
      obsidianVaultRoot: Option.getOrUndefined(
        Option.filter(obsidianVaultRoot, (root) => root.trim().length > 0),
      ),
    });
  }),
);
