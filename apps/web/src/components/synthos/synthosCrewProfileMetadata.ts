import type { SynthosProfileInput } from "@t3tools/contracts";

type Metadata = Pick<SynthosProfileInput, "name" | "description">;

export function refreshCrewProfileMetadata(
  previous: Metadata,
  draft: Metadata,
  latest: Metadata,
): Metadata {
  return {
    name: draft.name === previous.name ? latest.name : draft.name,
    description:
      draft.description === previous.description ? latest.description : draft.description,
  };
}
