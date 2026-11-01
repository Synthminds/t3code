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

// The HTTP client wraps the server's SynthosRequestError, so its reason sits down the cause chain.
export function libraryFailureMessage(error: unknown): string {
  const seen = new Set<unknown>();
  for (let current = error; typeof current === "object" && current !== null;) {
    if (seen.has(current)) break;
    seen.add(current);
    const reason = "reason" in current ? current.reason : undefined;
    if (typeof reason === "string" && Object.hasOwn(FAILURES, reason)) return FAILURES[reason]!;
    current = "cause" in current ? current.cause : undefined;
  }
  return error instanceof Error ? error.message : "The library request failed. Try again.";
}
