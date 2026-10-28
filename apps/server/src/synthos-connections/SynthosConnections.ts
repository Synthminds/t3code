import {
  SynthosConnectionCommand,
  SynthosConnectionError,
  SynthosDeviceProposal,
  SynthosMailEnvelope,
  synthosConnectionRequiredScope,
  type AuthEnvironmentScope,
  type SynthosConnectionResult,
  type SynthosConnectionStatus,
  type SynthosDeviceIntake,
  type SynthosMailDraft,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ConnectionHttp from "./ConnectionHttp.ts";
import * as ConnectionsConfig from "./ConnectionsConfig.ts";
import * as ObsidianVault from "./ObsidianVault.ts";
import * as RemoteConnections from "./RemoteConnections.ts";
import * as NativeToolInventory from "./NativeToolInventory.ts";

interface ConnectionActor {
  readonly sessionId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export class SynthosConnections extends Context.Service<
  SynthosConnections,
  {
    readonly execute: (
      actor: ConnectionActor,
      command: SynthosConnectionCommand,
    ) => Effect.Effect<SynthosConnectionResult, SynthosConnectionError>;
  }
>()("t3/synthos-connections/SynthosConnections") {}

interface OutboxRow {
  readonly id: string;
  readonly owner_session_id: string;
  readonly envelope_json: string;
  readonly content_hash: string;
  readonly state: SynthosMailDraft["state"];
  readonly message_id: string | null;
  readonly thread_id: string | null;
}

function vaultError(
  cause:
    | ObsidianVault.ObsidianVaultUnavailableError
    | ObsidianVault.ObsidianVaultValidationError
    | ObsidianVault.ObsidianVaultConflictError
    | ObsidianVault.ObsidianVaultIoError,
): SynthosConnectionError {
  const reason =
    cause._tag === "ObsidianVaultUnavailableError"
      ? "unavailable"
      : cause._tag === "ObsidianVaultConflictError"
        ? "conflict"
        : cause._tag === "ObsidianVaultIoError"
          ? cause.category === "not-found"
            ? "not_found"
            : "storage"
          : "unsafe_path";
  return new SynthosConnectionError({ connection: "obsidian", reason, cause });
}

function normalizeProposal(input: SynthosDeviceIntake, fingerprint: string): SynthosDeviceProposal {
  return {
    id: `device-${fingerprint}`,
    fingerprint,
    source: input.source,
    sourceId: input.sourceId.trim(),
    title: input.title.trim(),
    body: input.content.replaceAll("\r\n", "\n").trim(),
    capturedAt: DateTime.formatIso(DateTime.makeUnsafe(input.capturedAt)),
    status: "proposed",
    trust: "untrusted-input",
    executionAllowed: false,
  };
}

const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(SynthosMailEnvelope));
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(SynthosMailEnvelope));
const encodeProposal = Schema.encodeEffect(Schema.fromJsonString(SynthosDeviceProposal));
const decodeProposal = Schema.decodeEffect(Schema.fromJsonString(SynthosDeviceProposal));
const decodeCommand = Schema.decodeEffect(SynthosConnectionCommand);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ConnectionsConfig.ConnectionsConfig;
  const remote = yield* RemoteConnections.RemoteConnections;
  const vault = yield* ObsidianVault.ObsidianVault;
  const inventory = yield* NativeToolInventory.NativeToolInventory;

  const readDraft = Effect.fn("SynthosConnections.readDraft")(function* (row: OutboxRow) {
    const envelope = yield* decodeEnvelope(row.envelope_json).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
      ),
    );
    return {
      id: row.id,
      envelope,
      contentHash: row.content_hash,
      state: row.state,
      messageId: row.message_id,
      threadId: row.thread_id,
    } satisfies SynthosMailDraft;
  });

  const loadDraft = Effect.fn("SynthosConnections.loadDraft")(function* (
    actor: ConnectionActor,
    id: string,
  ) {
    const rows =
      yield* sql<OutboxRow>`SELECT * FROM synthos_mail_outbox WHERE id = ${id} AND owner_session_id = ${actor.sessionId}`.pipe(
        Effect.mapError(
          (cause) =>
            new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
        ),
      );
    if (!rows[0])
      return yield* new SynthosConnectionError({ connection: "agentmail", reason: "not_found" });
    return yield* readDraft(rows[0]);
  });

  const setMailState = Effect.fn("SynthosConnections.setMailState")(function* (
    id: string,
    state: SynthosMailDraft["state"],
    receipt?: { messageId: string; threadId: string },
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE synthos_mail_outbox SET state = ${state}, message_id = ${receipt?.messageId ?? null}, thread_id = ${receipt?.threadId ?? null}, updated_at = ${now} WHERE id = ${id} AND state != 'sent'`.pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
      ),
    );
  });

  const reconcile = Effect.fn("SynthosConnections.reconcile")(function* (
    actor: ConnectionActor,
    id: string,
  ) {
    const draft = yield* loadDraft(actor, id);
    if (draft.state !== "pending" && draft.state !== "unknown") return draft;
    const receipt = yield* remote.reconcileMail({
      id: draft.id,
      envelope: draft.envelope,
      contentHash: draft.contentHash,
    });
    if (receipt) yield* setMailState(id, "sent", receipt);
    else yield* setMailState(id, "unknown");
    return yield* loadDraft(actor, id);
  });

  const prepareMail = Effect.fn("SynthosConnections.prepareMail")(function* (
    actor: ConnectionActor,
    envelope: SynthosMailEnvelope,
  ) {
    if (!config.agentMailKey)
      return yield* new SynthosConnectionError({ connection: "agentmail", reason: "unavailable" });
    if (
      Buffer.byteLength(envelope.text, "utf8") > 200_000 ||
      !envelope.text.trim() ||
      /[\r\n\u0000]/.test(envelope.subject) ||
      envelope.to.some((address) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) ||
      /[\u0000-\u001f/\\]/.test(envelope.inboxId) ||
      envelope.inboxId === "." ||
      envelope.inboxId === ".."
    ) {
      return yield* new SynthosConnectionError({
        connection: "agentmail",
        reason: "invalid_input",
      });
    }
    const id = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) =>
            new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
        ),
      );
    const contentHash = yield* remote.hashMail(envelope);
    const envelopeJson = yield* encodeEnvelope(envelope).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "agentmail", reason: "invalid_input", cause }),
      ),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO synthos_mail_outbox (id, owner_session_id, envelope_json, content_hash, state, created_at, updated_at) VALUES (${id}, ${actor.sessionId}, ${envelopeJson}, ${contentHash}, 'prepared', ${now}, ${now})`.pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
      ),
    );
    return yield* loadDraft(actor, id);
  });

  const sendMail = Effect.fn("SynthosConnections.sendMail")(function* (
    actor: ConnectionActor,
    id: string,
    approvedHash: string,
  ) {
    const draft = yield* loadDraft(actor, id);
    if (
      draft.contentHash !== approvedHash ||
      (yield* remote.hashMail(draft.envelope)) !== approvedHash
    )
      return yield* new SynthosConnectionError({ connection: "agentmail", reason: "conflict" });
    if (draft.state === "pending" || draft.state === "unknown") return yield* reconcile(actor, id);
    if (draft.state !== "prepared") return draft;
    if (!config.agentMailKey)
      return yield* new SynthosConnectionError({ connection: "agentmail", reason: "unavailable" });
    const now = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* sql<{
      id: string;
    }>`UPDATE synthos_mail_outbox SET state = 'pending', approved_at = ${now}, updated_at = ${now} WHERE id = ${id} AND owner_session_id = ${actor.sessionId} AND state = 'prepared' AND content_hash = ${approvedHash} RETURNING id`.pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
      ),
    );
    if (claimed.length === 0) return yield* loadDraft(actor, id);
    // Claim commits before HTTP; a crash leaves a receipt to reconcile, never an automatic resend.
    yield* remote.sendMail({ id, envelope: draft.envelope }).pipe(
      Effect.matchEffect({
        onSuccess: (receipt) => setMailState(id, "sent", receipt),
        onFailure: (error) =>
          setMailState(
            id,
            error.status !== undefined && [400, 401, 403, 404, 422, 429].includes(error.status)
              ? "rejected"
              : "unknown",
          ),
      }),
      Effect.uninterruptible,
    );
    return yield* loadDraft(actor, id);
  });

  const intake = Effect.fn("SynthosConnections.intake")(function* (input: SynthosDeviceIntake) {
    if (
      !input.sourceId.trim() ||
      !input.title.trim() ||
      !input.content.trim() ||
      !Number.isFinite(Date.parse(input.capturedAt)) ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.capturedAt)
    )
      return yield* new SynthosConnectionError({ connection: "device", reason: "invalid_input" });
    const sourceIdentity = `${input.source}:${input.sourceId.trim()}`;
    const fingerprint = Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(sourceIdentity))
        .pipe(
          Effect.mapError(
            (cause) =>
              new SynthosConnectionError({ connection: "device", reason: "storage", cause }),
          ),
        ),
    );
    const proposal = normalizeProposal(input, fingerprint);
    const proposalJson = yield* encodeProposal(proposal).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "device", reason: "invalid_input", cause }),
      ),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql<{
      id: string;
    }>`INSERT INTO synthos_device_intake (id, source, source_id, proposal_json, created_at) VALUES (${proposal.id}, ${proposal.source}, ${proposal.sourceId}, ${proposalJson}, ${now}) ON CONFLICT(source, source_id) DO NOTHING RETURNING id`.pipe(
      Effect.mapError(
        (cause) => new SynthosConnectionError({ connection: "device", reason: "storage", cause }),
      ),
    );
    const rows = yield* sql<{
      proposal_json: string;
    }>`SELECT proposal_json FROM synthos_device_intake WHERE source = ${proposal.source} AND source_id = ${proposal.sourceId}`.pipe(
      Effect.mapError(
        (cause) => new SynthosConnectionError({ connection: "device", reason: "storage", cause }),
      ),
    );
    const stored = yield* decodeProposal(rows[0]?.proposal_json ?? "null").pipe(
      Effect.mapError(
        (cause) => new SynthosConnectionError({ connection: "device", reason: "storage", cause }),
      ),
    );
    return { proposal: stored, duplicate: inserted.length === 0 };
  });

  const status = (): ReadonlyArray<SynthosConnectionStatus> => [
    {
      id: "agentmail",
      label: "AgentMail",
      state: config.agentMailKey ? "configured" : "unavailable",
      capabilities: ["mail.list", "mail.prepare", "mail.send", "mail.reconcile"],
      reason: config.agentMailKey
        ? "Credential configured; connectivity has not been checked. Sending requires approval of exact content."
        : "Set AGENTMAIL_API_KEY on this host.",
    },
    {
      id: "mem",
      label: "Mem",
      state: config.memKey ? "configured" : "unavailable",
      capabilities: ["mem.search", "mem.read", "mem.write"],
      reason: config.memKey
        ? "Credential configured; connectivity has not been checked. Updates require the current note version."
        : "Set MEM_API_KEY on this host.",
    },
    {
      id: "obsidian",
      label: "Obsidian",
      state: config.obsidianVaultRoot ? "configured" : "unavailable",
      capabilities: ["obsidian.list", "obsidian.read", "obsidian.write"],
      reason: config.obsidianVaultRoot
        ? "Vault path configured; availability is checked when accessed. Saves require the current content hash."
        : "Set SYNTHOS_OBSIDIAN_VAULT_ROOT to an allowed vault directory on this host.",
    },
    {
      id: "harness",
      label: "Harness",
      state: "companion",
      capabilities: ["device.intake"],
      reason:
        "Serial attachment and STOP are reported by the local companion. This host accepts its captures for review.",
    },
    {
      id: "fieldy",
      label: "Fieldy",
      state: "companion",
      capabilities: ["device.intake"],
      reason:
        "The local companion imports Fieldy captures using its account configuration. This host does not observe that account's connection state.",
    },
    {
      id: "g2",
      label: "Even Realities G2",
      state: "companion",
      capabilities: ["device.intake"],
      reason:
        "The phone companion reports the Even Hub SDK attachment state. Captures arriving here remain proposals.",
    },
  ];

  const execute: SynthosConnections["Service"]["execute"] = Effect.fn("SynthosConnections.execute")(
    function* (actor, rawCommand) {
      const command = yield* decodeCommand(rawCommand).pipe(
        Effect.mapError(
          (cause) =>
            new SynthosConnectionError({ connection: "request", reason: "invalid_input", cause }),
        ),
      );
      const scope = synthosConnectionRequiredScope(command);
      if (!actor.sessionId || !actor.scopes.includes(scope))
        return yield* new SynthosConnectionError({ connection: "request", reason: "forbidden" });
      switch (command.type) {
        case "status":
          return { connections: status() };
        case "tools.inventory":
          return yield* inventory.list({ includeActivity: actor.scopes.includes("terminal:read") });
        case "mail.list":
          return yield* remote.listMail(command);
        case "mail.prepare":
          return yield* prepareMail(actor, {
            inboxId: command.inboxId,
            to: command.to,
            subject: command.subject,
            text: command.text,
          });
        case "mail.send":
          return yield* sendMail(actor, command.id, command.contentHash);
        case "mail.reconcile":
          return yield* reconcile(actor, command.id);
        case "mail.outbox": {
          const rows =
            yield* sql<OutboxRow>`SELECT * FROM synthos_mail_outbox WHERE owner_session_id = ${actor.sessionId} ORDER BY created_at DESC LIMIT 50`.pipe(
              Effect.mapError(
                (cause) =>
                  new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
              ),
            );
          return { drafts: yield* Effect.forEach(rows, readDraft) };
        }
        case "mem.read":
          return yield* remote.readMem(command.noteId);
        case "mem.search":
          return yield* remote.searchMem(command);
        case "mem.write":
          return yield* remote.writeMem(command);
        case "obsidian.list":
          return yield* vault.list(command).pipe(Effect.mapError(vaultError));
        case "obsidian.read":
          return yield* vault.read(command).pipe(Effect.mapError(vaultError));
        case "obsidian.write":
          return yield* vault.write(command).pipe(Effect.mapError(vaultError));
        case "device.intake":
          return yield* intake(command);
        case "device.list": {
          const rows = yield* sql<{
            proposal_json: string;
          }>`SELECT proposal_json FROM synthos_device_intake ORDER BY created_at DESC LIMIT 200`.pipe(
            Effect.mapError(
              (cause) =>
                new SynthosConnectionError({ connection: "device", reason: "storage", cause }),
            ),
          );
          const proposals = yield* Effect.forEach(
            rows,
            Effect.fn("SynthosConnections.decodeProposal")(function* (row) {
              return yield* decodeProposal(row.proposal_json).pipe(
                Effect.mapError(
                  (cause) =>
                    new SynthosConnectionError({ connection: "device", reason: "storage", cause }),
                ),
              );
            }),
          );
          return { proposals };
        }
      }
    },
  );
  return SynthosConnections.of({ execute });
});

export const layer = Layer.effect(SynthosConnections, make);

export const layerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConnectionsConfig.ConnectionsConfig;
    return layer.pipe(
      Layer.provide(NativeToolInventory.layer),
      Layer.provide(
        RemoteConnections.layer.pipe(
          Layer.provide(ConnectionHttp.layer.pipe(Layer.provide(ConnectionHttp.layerFetch))),
        ),
      ),
      Layer.provide(
        ObsidianVault.layer(
          config.obsidianVaultRoot ? { vaultRoot: config.obsidianVaultRoot } : {},
        ),
      ),
    );
  }),
).pipe(Layer.provide(ConnectionsConfig.layer));
