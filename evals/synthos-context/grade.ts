export function grade(input: {
  readonly routes: readonly string[];
  readonly notes: readonly string[];
  readonly expectedRoutes: readonly string[];
  readonly expectedNotes: readonly string[];
  readonly excludedNotes: readonly string[];
  readonly memoryBytes: number;
  readonly packetBytes: number;
  readonly policyIntact: boolean;
}) {
  const coverage = (expected: readonly string[], actual: readonly string[]) =>
    expected.length === 0
      ? 1
      : expected.filter((value) => actual.includes(value)).length / expected.length;
  const scores = {
    route_coverage: coverage(input.expectedRoutes, input.routes),
    memory_coverage: coverage(input.expectedNotes, input.notes),
    excluded_memory_rejected: input.excludedNotes.some((path) => input.notes.includes(path))
      ? 0
      : 1,
    bounded_context:
      input.memoryBytes <= 4096 && input.packetBytes <= 12 * 1024 && input.notes.length <= 5
        ? 1
        : 0,
    required_policy: input.policyIntact ? 1 : 0,
  };
  return { scores, pass: Object.values(scores).every((score) => score === 1) };
}
