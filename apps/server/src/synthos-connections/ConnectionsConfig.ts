import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export type DamOwnerSetting = "on" | "off" | "unrecognized";

export class ConnectionsConfig extends Context.Service<
  ConnectionsConfig,
  {
    readonly agentMailKey: Redacted.Redacted<string> | undefined;
    readonly memKey: Redacted.Redacted<string> | undefined;
    readonly obsidianVaultRoot: string | undefined;
    readonly damRoot: string | undefined;
    readonly damOwner: DamOwnerSetting;
  }
>()("t3/synthos-connections/ConnectionsConfig") {}

// An optional opt-in must never stop the server: a value it cannot read leaves owner mode off.
function parseDamOwner(value: string | undefined): DamOwnerSetting {
  const setting = value?.trim().toLowerCase() ?? "";
  if (setting === "1" || setting === "true") return "on";
  if (setting === "" || setting === "0" || setting === "false") return "off";
  return "unrecognized";
}

export const layer = Layer.effect(
  ConnectionsConfig,
  Effect.gen(function* () {
    const agentMailKey = yield* Config.Redacted("AGENTMAIL_API_KEY").pipe(Config.option);
    const memKey = yield* Config.Redacted("MEM_API_KEY").pipe(Config.option);
    const obsidianVaultRoot = yield* Config.String("SYNTHOS_OBSIDIAN_VAULT_ROOT").pipe(
      Config.option,
    );
    const damRoot = yield* Config.String("SYNTHOS_DAM_ROOT").pipe(Config.option);
    const damOwner = parseDamOwner(
      Option.getOrUndefined(yield* Config.String("SYNTHOS_DAM_OWNER").pipe(Config.option)),
    );
    if (damOwner === "unrecognized")
      yield* Effect.logWarning(
        "SYNTHOS_DAM_OWNER is not 1, true, 0 or false; owner mode is off",
      ).pipe(Effect.annotateLogs({ code: "DAM_OWNER_UNRECOGNIZED" }));
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
      damRoot: Option.getOrUndefined(Option.filter(damRoot, (root) => root.trim().length > 0)),
      damOwner,
    });
  }),
);
