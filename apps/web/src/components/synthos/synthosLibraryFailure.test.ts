import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "@t3tools/client-runtime/rpc";
import { EnvironmentScopeRequiredError, SynthosRequestError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { libraryFailureMessage } from "./synthosLibraryFailure";

const url = "http://localhost:7663/api/synthos/connections";

describe("libraryFailureMessage", () => {
  it("reads the server's reason through the HTTP client's wrapping error", () => {
    const failure = (reason: string) =>
      new RemoteEnvironmentAuthFetchError({
        message: `Failed to fetch remote environment endpoint ${url} (SynthosRequestError: SynthOS request could not proceed: ${reason}.).`,
        cause: new SynthosRequestError({ reason }),
      });
    expect(libraryFailureMessage(failure("storage_only"))).toBe(
      "This file lives in DAM's private storage. Retrieve it through DAM's authenticated file route.",
    );
    expect(libraryFailureMessage(failure("unavailable"))).toBe(
      "The DAM library is not available on this host. Check its configuration.",
    );
    expect(libraryFailureMessage(failure("knowledge_conflict"))).toBe(
      "DAM could not answer this request.",
    );
  });

  it("gives plain messages for failures that carry no SynthOS reason", () => {
    const rows = [
      [
        new RemoteEnvironmentAuthFetchError({
          message: `Failed to fetch remote environment endpoint ${url} (TypeError: fetch failed).`,
          cause: new TypeError("fetch failed"),
        }),
        "This host could not be reached. Check that it is running.",
      ],
      [
        new RemoteEnvironmentAuthTimeoutError(url, 15_000),
        "This host did not answer in time. Try again.",
      ],
      [
        new RemoteEnvironmentAuthUndeclaredStatusError(url, 400),
        "This host's server does not know this library request. Update its server.",
      ],
      [
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          requiredScope: "orchestration:read",
          traceId: "trace-1",
        }),
        "This session lacks the orchestration:read permission the library needs.",
      ],
      ["offline", "The library request failed. Try again."],
    ] as const;
    for (const [error, message] of rows) expect(libraryFailureMessage(error)).toBe(message);
  });
});
