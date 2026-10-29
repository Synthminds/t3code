# Managed missions

SynthOS coordinates missions through T3's existing threads, providers, worktrees, command receipts, and cancellation. T3 remains the execution authority; introducing another execution loop here would bypass its evidence and permission boundaries.

The complete pinned GCH kernel accompanies each frozen role packet. Supplemental repository guidance and memories are source material, not authority to change permissions. Preserve policy and packet integrity checks when changing context assembly.

Workflow state survives restart. Verification depends on observed command receipts and candidate checkpoints; a model's prose is not verification. Unknown usage cannot be silently converted to zero. See [the GCH integration limits](../../../../docs/user/synthos.md#inspect-gch-integration).

Provider handoffs are lossy textual summaries, not restored native model state. Retrieve omitted evidence before depending on it; see [context handoffs](../../../../docs/internals/context-handoffs.md).

Before changing dispatch or persistence, read [orchestration architecture](../../../../docs/internals/overview.md) and [Effect services](../../../../docs/internals/effect-services.md). Transport handlers should call services rather than own decisions.
