import { RemoteEnvironmentAuthFetchError } from "@t3tools/client-runtime/rpc";
import { SynthosRequestError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { libraryFailureMessage } from "./synthosLibraryFailure";

describe("libraryFailureMessage", () => {
  it("reads the server's reason through the HTTP client's wrapping error", () => {
    const failure = (reason: string) =>
      new RemoteEnvironmentAuthFetchError({
        message: `Failed to fetch remote environment endpoint http://localhost:7663/api/synthos/connections (SynthosRequestError: SynthOS request could not proceed: ${reason}.).`,
        cause: new SynthosRequestError({ reason }),
      });
    expect(libraryFailureMessage(failure("storage_only"))).toBe(
      "This file lives in DAM's private storage. Retrieve it through DAM's authenticated file route.",
    );
    expect(libraryFailureMessage(failure("unavailable"))).toBe(
      "The DAM library is not available on this host. Check its configuration.",
    );
    expect(libraryFailureMessage(failure("knowledge_conflict"))).toMatch(/^Failed to fetch/);
    expect(libraryFailureMessage("offline")).toBe("The library request failed. Try again.");
  });
});
