# SynthOS context selection

This deterministic benchmark runs synthetic tasks and notes through the production repository router, memory selector, and GCH packet builder. It compares a packet without supplemental retrieval against the same packet with routed sources and recalled memories. It makes no model calls and does not measure model comprehension or billed token savings.

From `evals/`, run:

```sh
pnpm synthos-context --out runs/context
pnpm synthos-context --out runs/context-next --baseline runs/context/results.json
```

Use `--case <id>` to select cases. `results.json` contains selection decisions, omissions, hashes, byte counts, input-token estimates, and scores. `summary.json` retains an optional prior run for comparison. The command fails if the routed variant misses an expected source, supplies excluded material, exceeds bounds, or loses the pinned policy. Baseline failures on new capabilities are expected; they are not regressions.

The fixtures cover project-first recall, neighborhood suppression when three project notes qualify, an unrelated-memory control, cross-boundary routing, and duplicate notes. Filesystem permissions, stale-source races, persistence, and dispatch integrity are exercised by server tests. The grader's negative controls run in `run.test.ts`.

## Braintrust

Provide `BRAINTRUST_API_KEY` and `BRAINTRUST_PROJECT_ID` privately on the evaluation host, then add `--braintrust`. This creates a private experiment in the selected project using the pinned SDK. Only synthetic case input, selection metadata, scores, and hashes are uploaded; the runner does not read a real vault or send the GCH kernel. Git metadata collection is disabled. No model inference is started. Braintrust account limits still apply.

Without the flag, the run is local. With the flag but missing credentials, local artifacts are retained and the command reports that upload was not performed. Do not confuse a successful local run with a successful Braintrust upload.

Real-model evaluation remains a release qualification step requiring an explicit inference budget: run identical synthetic tasks against baseline and routed packets using the same inexpensive model, compare required-constraint adherence and source use across repeated samples, and report observed usage independently of the estimates here. This runner intentionally does not invoke paid models.
