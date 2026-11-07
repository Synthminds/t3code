const FAILURES: Record<string, string> = {
  unavailable: "The DAM library is not available on this host. Check its configuration.",
  forbidden: "This session cannot read the DAM library.",
  not_found: "This item or file is not in the library, or this session cannot see it.",
  invalid_input: "DAM rejected the request. Check the search filters.",
  response_invalid: "DAM answered in a form this version of SynthOS cannot read.",
  response_too_large: "This item is too large to show here.",
  remote_rejected: "DAM could not answer this request.",
  transport: "DAM did not answer. Try again.",
  storage_only:
    "This file lives in DAM's private storage. Retrieve it through DAM's authenticated file route.",
};

// Failures with no SynthOS reason, keyed by the error the environment client raises.
const REQUEST_FAILURES: Record<string, string> = {
  RemoteEnvironmentAuthFetchError: "This host could not be reached. Check that it is running.",
  RemoteEnvironmentAuthTimeoutError: "This host did not answer in time. Try again.",
  RemoteEnvironmentAuthInvalidJsonError:
    "This host answered in a form this client cannot read. Update its server.",
  EnvironmentScopeRequiredError:
    "This session lacks the orchestration:read permission the library needs.",
  EnvironmentAuthInvalidError: "This session is no longer signed in to this host. Pair again.",
  EnvironmentOperationForbiddenError: "This host does not allow this session to read the library.",
  EnvironmentInternalError: "This host hit an internal error. Try again.",
};

const tagOf = (value: object) =>
  "_tag" in value && typeof value._tag === "string" ? value._tag : undefined;

// The HTTP client wraps the server's SynthosRequestError, so its reason sits down the cause chain.
export function libraryFailureMessage(error: unknown): string {
  const chain: Array<object> = [];
  for (
    let current = error;
    typeof current === "object" && current !== null && !chain.includes(current);
    current = "cause" in current ? current.cause : undefined
  )
    chain.push(current);
  const request = chain.find((entry) => tagOf(entry) === "SynthosRequestError");
  if (request !== undefined) {
    const reason = "reason" in request ? request.reason : undefined;
    return typeof reason === "string" && Object.hasOwn(FAILURES, reason)
      ? FAILURES[reason]!
      : FAILURES.remote_rejected!;
  }
  const outer = chain[0];
  if (outer !== undefined && tagOf(outer) === "RemoteEnvironmentAuthUndeclaredStatusError")
    // A server from before a library command answers it as a bad request.
    return "status" in outer && outer.status === 400
      ? "This host's server does not know this library request. Update its server."
      : "This host answered with an unexpected status. Try again.";
  for (const entry of chain) {
    const tag = tagOf(entry);
    if (tag !== undefined && Object.hasOwn(REQUEST_FAILURES, tag)) return REQUEST_FAILURES[tag]!;
  }
  return error instanceof Error ? error.message : "The library request failed. Try again.";
}
