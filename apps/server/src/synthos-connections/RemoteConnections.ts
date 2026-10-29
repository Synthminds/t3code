import {
  SynthosConnectionError,
  SynthosMailEnvelope,
  type SynthosMemNote,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ConnectionHttp from "./ConnectionHttp.ts";
import * as ConnectionsConfig from "./ConnectionsConfig.ts";

const MemNote = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  updated_at: Schema.String,
  trashed_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const MemSearch = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
      updated_at: Schema.String,
    }),
  ),
  has_next_page: Schema.Boolean,
});
const MailMessage = Schema.Struct({
  message_id: Schema.String,
  thread_id: Schema.String,
  from: Schema.String,
  to: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  timestamp: Schema.String,
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
});
const MailList = Schema.Struct({
  messages: Schema.Array(MailMessage),
  next_page_token: Schema.optionalKey(Schema.String),
});
const MailReceipt = Schema.Struct({ message_id: Schema.String, thread_id: Schema.String });
const MailContent = Schema.Struct({
  ...MailMessage.fields,
  text: Schema.optionalKey(Schema.String),
});

interface MailMessageSummary {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly preview: string;
  readonly timestamp: string;
}

export class RemoteConnections extends Context.Service<
  RemoteConnections,
  {
    readonly hashMail: (
      envelope: SynthosMailEnvelope,
    ) => Effect.Effect<string, SynthosConnectionError>;
    readonly listMail: (input: {
      readonly inboxId: string;
      readonly limit?: number;
      readonly pageToken?: string;
    }) => Effect.Effect<
      { messages: ReadonlyArray<MailMessageSummary>; nextPageToken: string | null },
      SynthosConnectionError
    >;
    readonly sendMail: (input: {
      readonly id: string;
      readonly envelope: SynthosMailEnvelope;
    }) => Effect.Effect<{ messageId: string; threadId: string }, SynthosConnectionError>;
    readonly reconcileMail: (input: {
      readonly id: string;
      readonly envelope: SynthosMailEnvelope;
      readonly contentHash: string;
    }) => Effect.Effect<{ messageId: string; threadId: string } | null, SynthosConnectionError>;
    readonly readMem: (noteId: string) => Effect.Effect<SynthosMemNote, SynthosConnectionError>;
    readonly searchMem: (input: {
      readonly query: string;
      readonly limit?: number;
    }) => Effect.Effect<
      {
        notes: ReadonlyArray<{ id: string; title: string; snippet: string; updatedAt: string }>;
        truncated: boolean;
      },
      SynthosConnectionError
    >;
    readonly writeMem: (input: {
      readonly noteId?: string;
      readonly content: string;
      readonly expectedVersion?: number;
    }) => Effect.Effect<SynthosMemNote, SynthosConnectionError>;
  }
>()("t3/synthos-connections/RemoteConnections") {}

const validId = (value: string) =>
  value.length > 0 &&
  value.length <= 256 &&
  value !== "." &&
  value !== ".." &&
  !/[\u0000-\u001f/\\]/.test(value);
const mapMem = (note: typeof MemNote.Type): SynthosMemNote => ({
  id: note.id,
  title: note.title,
  content: note.content,
  version: note.version,
  updatedAt: note.updated_at,
  trashed: note.trashed_at != null,
});

const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(SynthosMailEnvelope));
const decodeMailList = Schema.decodeUnknownEffect(MailList);
const decodeMailReceipt = Schema.decodeUnknownEffect(MailReceipt);
const decodeMailContent = Schema.decodeUnknownEffect(MailContent);
const decodeMemNote = Schema.decodeUnknownEffect(MemNote);
const decodeMemSearch = Schema.decodeUnknownEffect(MemSearch);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hashMail = Effect.fn("RemoteConnections.hashMail")(function* (
    envelope: SynthosMailEnvelope,
  ) {
    const encoded = yield* encodeEnvelope(envelope).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "agentmail", reason: "invalid_input", cause }),
      ),
    );
    return Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(encoded))
        .pipe(
          Effect.mapError(
            (cause) =>
              new SynthosConnectionError({ connection: "agentmail", reason: "storage", cause }),
          ),
        ),
    );
  });
  const http = yield* ConnectionHttp.ConnectionHttp;
  const config = yield* ConnectionsConfig.ConnectionsConfig;
  const mail = Effect.fn("RemoteConnections.mail")(function* (
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ) {
    return yield* http.request({
      connection: "agentmail",
      key: config.agentMailKey,
      path,
      method,
      ...(body === undefined ? {} : { body }),
    });
  });
  const mem = Effect.fn("RemoteConnections.mem")(function* (
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ) {
    return yield* http.request({
      connection: "mem",
      key: config.memKey,
      path,
      method,
      ...(body === undefined ? {} : { body }),
    });
  });

  const listMail: RemoteConnections["Service"]["listMail"] = Effect.fn(
    "RemoteConnections.listMail",
  )(function* (input) {
    if (!validId(input.inboxId))
      return yield* new SynthosConnectionError({
        connection: "agentmail",
        reason: "invalid_input",
      });
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const query = new URLSearchParams({ limit: String(limit) });
    if (input.pageToken) query.set("page_token", input.pageToken);
    const raw = yield* mail(`/v0/inboxes/${encodeURIComponent(input.inboxId)}/messages?${query}`);
    const value = yield* decodeMailList(raw).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({
            connection: "agentmail",
            reason: "response_invalid",
            cause,
          }),
      ),
    );
    return {
      messages: value.messages.slice(0, limit).map((message) => ({
        id: message.message_id,
        threadId: message.thread_id,
        from: message.from,
        to: message.to ?? [],
        subject: (message.subject ?? "").slice(0, 998),
        preview: (message.preview ?? "").slice(0, 4_000),
        timestamp: message.timestamp,
      })),
      nextPageToken: value.next_page_token ?? null,
    };
  });

  const sendMail: RemoteConnections["Service"]["sendMail"] = Effect.fn(
    "RemoteConnections.sendMail",
  )(function* ({ id, envelope }) {
    if (!validId(envelope.inboxId))
      return yield* new SynthosConnectionError({
        connection: "agentmail",
        reason: "invalid_input",
      });
    // An immutable payload avoids approving one provider draft version and sending a later edit.
    const raw = yield* mail(
      `/v0/inboxes/${encodeURIComponent(envelope.inboxId)}/messages/send`,
      "POST",
      {
        to: envelope.to,
        subject: envelope.subject,
        text: envelope.text,
        labels: [`synthos:${id}`],
      },
    );
    const receipt = yield* decodeMailReceipt(raw).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({
            connection: "agentmail",
            reason: "response_invalid",
            cause,
          }),
      ),
    );
    return { messageId: receipt.message_id, threadId: receipt.thread_id };
  });

  const reconcileMail: RemoteConnections["Service"]["reconcileMail"] = Effect.fn(
    "RemoteConnections.reconcileMail",
  )(function* (input) {
    const label = `synthos:${input.id}`;
    const query = new URLSearchParams({ limit: "20", labels: label });
    const prefix = `/v0/inboxes/${encodeURIComponent(input.envelope.inboxId)}/messages`;
    const raw = yield* mail(`${prefix}?${query}`);
    const listing = yield* decodeMailList(raw).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({
            connection: "agentmail",
            reason: "response_invalid",
            cause,
          }),
      ),
    );
    for (const candidate of listing.messages.slice(0, 20)) {
      if (!candidate.labels?.includes(label) || !candidate.labels.includes("sent")) continue;
      const fullRaw = yield* mail(`${prefix}/${encodeURIComponent(candidate.message_id)}`);
      const full = yield* decodeMailContent(fullRaw).pipe(
        Effect.mapError(
          (cause) =>
            new SynthosConnectionError({
              connection: "agentmail",
              reason: "response_invalid",
              cause,
            }),
        ),
      );
      if (
        full.labels?.includes(label) &&
        full.labels.includes("sent") &&
        (yield* hashMail({
          inboxId: input.envelope.inboxId,
          to: full.to ?? [],
          subject: full.subject ?? "",
          text: full.text ?? "",
        })) === input.contentHash
      ) {
        return { messageId: full.message_id, threadId: full.thread_id };
      }
    }
    return null;
  });

  const readMem: RemoteConnections["Service"]["readMem"] = Effect.fn("RemoteConnections.readMem")(
    function* (noteId) {
      if (!validId(noteId))
        return yield* new SynthosConnectionError({ connection: "mem", reason: "invalid_input" });
      const raw = yield* mem(`/v2/notes/${encodeURIComponent(noteId)}`);
      return mapMem(
        yield* decodeMemNote(raw).pipe(
          Effect.mapError(
            (cause) =>
              new SynthosConnectionError({ connection: "mem", reason: "response_invalid", cause }),
          ),
        ),
      );
    },
  );

  const searchMem: RemoteConnections["Service"]["searchMem"] = Effect.fn(
    "RemoteConnections.searchMem",
  )(function* (input) {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const raw = yield* mem(`/v2/notes/search?limit=${limit}&offset=0`, "POST", {
      query: input.query,
      config: { include_note_content: false },
    });
    const value = yield* decodeMemSearch(raw).pipe(
      Effect.mapError(
        (cause) =>
          new SynthosConnectionError({ connection: "mem", reason: "response_invalid", cause }),
      ),
    );
    return {
      notes: value.results.slice(0, limit).map((note) => ({
        id: note.id,
        title: note.title.slice(0, 256),
        snippet: (note.snippet ?? "").slice(0, 4_000),
        updatedAt: note.updated_at,
      })),
      truncated: value.has_next_page || value.results.length > limit,
    };
  });

  const writeMem: RemoteConnections["Service"]["writeMem"] = Effect.fn(
    "RemoteConnections.writeMem",
  )(function* (input) {
    if (
      Buffer.byteLength(input.content, "utf8") > 200_000 ||
      !input.content.trim() ||
      (input.noteId !== undefined &&
        (!validId(input.noteId) ||
          !Number.isSafeInteger(input.expectedVersion) ||
          (input.expectedVersion ?? 0) < 1)) ||
      (input.noteId === undefined && input.expectedVersion !== undefined)
    ) {
      return yield* new SynthosConnectionError({ connection: "mem", reason: "invalid_input" });
    }
    // Mem v2 requires the exact version in the write itself, which closes read/write races.
    const raw = yield* mem(
      input.noteId ? `/v2/notes/${encodeURIComponent(input.noteId)}` : "/v2/notes",
      input.noteId ? "PATCH" : "POST",
      { content: input.content, ...(input.noteId ? { version: input.expectedVersion } : {}) },
    );
    return mapMem(
      yield* decodeMemNote(raw).pipe(
        Effect.mapError(
          (cause) =>
            new SynthosConnectionError({ connection: "mem", reason: "response_invalid", cause }),
        ),
      ),
    );
  });

  return RemoteConnections.of({
    hashMail,
    listMail,
    sendMail,
    reconcileMail,
    readMem,
    searchMem,
    writeMem,
  });
});

export const layer = Layer.effect(RemoteConnections, make);
