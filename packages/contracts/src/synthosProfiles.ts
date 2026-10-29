import * as Schema from "effect/Schema";
import type { AuthEnvironmentScope } from "./auth.ts";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SynthosBinding, SynthosBudget } from "./synthos.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/));
const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(240));

export const SynthosProfileInput = Schema.Struct({
  id: Id,
  name: ShortText,
  description: Schema.String.check(Schema.isMaxLength(2000)),
  bindings: Schema.Array(SynthosBinding).check(Schema.isMinLength(4), Schema.isMaxLength(10)),
  budget: SynthosBudget,
  checkCommands: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
});
export type SynthosProfileInput = typeof SynthosProfileInput.Type;

export const SynthosProfile = Schema.Struct({
  ...SynthosProfileInput.fields,
  version: PositiveInt,
  deleted: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  createdBy: Schema.String,
  updatedBy: Schema.String,
});
export type SynthosProfile = typeof SynthosProfile.Type;

export const SynthosProfileCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("list"),
    includeDeleted: Schema.optionalKey(Schema.Boolean),
    limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
  }),
  Schema.Struct({ type: Schema.Literal("get"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("upsert"),
    profile: SynthosProfileInput,
    expectedVersion: Schema.NullOr(PositiveInt),
  }),
  Schema.Struct({
    type: Schema.Literals(["delete", "restore"]),
    id: Id,
    expectedVersion: PositiveInt,
  }),
]);
export type SynthosProfileCommand = typeof SynthosProfileCommand.Type;

export const SynthosProfileResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("list"),
    profiles: Schema.Array(SynthosProfile),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("profile"), profile: SynthosProfile }),
]);
export type SynthosProfileResult = typeof SynthosProfileResult.Type;

export function synthosProfileRequiredScope(command: SynthosProfileCommand): AuthEnvironmentScope {
  return command.type === "list" || command.type === "get"
    ? "orchestration:read"
    : "orchestration:operate";
}

export class SynthosProfileError extends Schema.TaggedError<SynthosProfileError>()(
  "SynthosProfileError",
  {
    reason: Schema.Literals(["forbidden", "invalid", "not_found", "conflict", "storage"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Crew profile operation failed: ${this.reason}.`;
  }
}
