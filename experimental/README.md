# Model behavior laboratory

This directory contains experimental tooling for studying model behavior and
testing candidate improvements to the plugin. It is not part of the shipped
Obsidian plugin.

The dependency boundary is one-way:

- Laboratory code may import production contracts and pure logic from `src/`.
- Production code in `src/` must never import from `experimental/`.
- A laboratory run must not receive a real vault path or an Obsidian `Vault`.
- Model tool calls are observations until a future sandbox explicitly executes
  them against a disposable fixture.

## First vertical slice

The initial runner exercises the existing provider-independent `ChatClient`
completion boundary. A scenario supplies a complete `ChatRequest`, sampling
conditions, and focused evaluators. Each iteration produces a self-contained
trace containing:

- the exact request and model conditions;
- response text, tool calls, usage, stop reason, and duration;
- deterministic evaluation checks;
- transport, timeout, and evaluator failures;
- scenario and trace schema versions.

The runner does not write files directly. Callers provide an artifact sink, so
tests can use memory and a future command-line adapter can write only beneath a
designated artifact directory.

Phase 2 adds a concrete append-only sink fixed beneath
`experimental/artifacts/`, a run manifest and final summary, explicit loopback
LM Studio subject configuration, endpoint and model preflight, and a bundled
experimental command-line interface. See `PROGRESS.md` for phase status and the
next implementation target.

Run `npm run lab:check` to type-check the laboratory. The normal `npm run lint`
and `npm test` commands also cover its source and behavior.

## Running the local control

LM Studio must be running with its local server enabled. In PowerShell:

```powershell
$env:LAB_MODEL_ID = "the-model-id-reported-by-lm-studio"
$env:LAB_SOURCE_REVISION = "the-source-revision-or-worktree-label"
npm run lab:run -- --scenario basic-instruction --iterations 3
```

The endpoint defaults to `http://127.0.0.1:1234/v1`. Override it only with
another loopback URL:

```powershell
$env:LAB_LMSTUDIO_URL = "http://localhost:1234/v1"
```

Optional reproducibility metadata can be supplied through
`LAB_MODEL_ARTIFACT`, `LAB_MODEL_QUANTIZATION`,
`LAB_INFERENCE_ENGINE_VERSION`, and `LAB_CHAT_TEMPLATE`.

List the closed scenario registry without connecting to LM Studio:

```powershell
npm run lab:run -- --list-scenarios
```

Run the frozen explicit-path episode with the experimental, exact-prefix
normalization candidate:

```powershell
$env:LAB_MODEL_ID = "gemma4-26b-a4b-uncensored-hauhaucs-balanced"
npm run lab:run -- --episode read-mara-explicit-path --response-normalizer tool-result-control-token-prefix-v1
```

Candidate episode evidence records both raw provider text and normalized text.
The candidate is laboratory-only and does not change `src/`.

The safer opt-in path requires an exact match against recorded model or
chat-template provenance:

```powershell
npm run lab:run -- --episode read-mara-explicit-path --compatibility-policy gemma4-tool-result-control-token-prefix-v1
```

Repeat an episode beneath one append-only run manifest with explicit bounds:

```powershell
npm run lab:run -- --episode read-mara-explicit-path --iterations 3 --timeout-ms 60000 --max-rounds 5 --max-tool-calls 10 --compatibility-policy gemma4-tool-result-control-token-prefix-v1
```

Run the four configurations with identical `--iterations`, `--timeout-ms`,
`--max-rounds`, and `--max-tool-calls` values, then compare their immutable run
IDs in baseline, direct candidate, policy candidate, and clean canary order:

```powershell
npm run lab:run -- --compare-runs <baseline-run>,<direct-run>,<policy-run>,<canary-run>
```

The comparison command does not connect to LM Studio. It freezes the four input
manifests in `experimental/artifacts/comparisons/<comparison-id>/manifest.json`
before writing `comparison.json` and `report.md`. A failing clean canary on the
affected subject is reported as expected diagnostic evidence. Input artifacts
are read-only and remain canonical.

Run the reviewed-write episode to exercise the disposable mutation boundary:

```powershell
npm run lab:run -- --episode reviewed-write --max-rounds 5 --max-tool-calls 3
```

This scenario advertises only `read_file` and `write_file`. Its frozen review
policy applies the proposed overwrite inside the in-memory fixture. The episode
trace records the proposal, review disposition, before and after snapshots,
state diff, and exact replay check. Move, trash, executable writes, reserved
configuration paths, and paths outside the fixture remain denied.

`read-clean-canary` is a regression canary for known-clean subjects. It passes
only when a post-tool response is already clean and the selected normalizer
changes no response text. A failure on the affected Gemma4 model confirms that
the subject emitted the known prefix, it is not a candidate regression.

Each measured run creates this append-only structure:

```text
experimental/artifacts/<run-id>/
  manifest.json
  report.md
  summary.json
  episodes/
    <episode-id>/
      episode.json
```

Completion scenarios retain the existing `trials/0001.json` layout. Episode
summaries and reports are derived views. Each episode JSON file remains the
canonical, self-contained raw trace and is created exclusively.

Preflight completes before `manifest.json` is created. An unavailable endpoint
or missing model therefore does not produce a misleading measured run.

CLI exit codes are:

- `0`: all measured trials passed, or an informational command completed;
- `1`: a measured trial failed or the run could not complete;
- `2`: command-line or environment configuration is invalid;
- `3`: LM Studio endpoint or model preflight failed.

## Behavioral profiles

List the closed Phase 4 mapping registry:

```powershell
npm run lab:run -- --list-behavior-mappings
```

Derive a profile from compatible immutable completion and episode run IDs:

```powershell
npm run lab:run -- --profile-runs <run-id>,<run-id>,<run-id>
```

Compare two profiles over only their common versioned scenario evidence:

```powershell
npm run lab:run -- --compare-profiles <left-profile-id>,<right-profile-id>
```

Profile manifests are written before derivation under
`experimental/artifacts/profiles/<profile-id>/`. Differentials use
`experimental/artifacts/differentials/<differential-id>/`. Both are append-only
derived views. They never rewrite source runs or contact LM Studio.

Profiles use separate dimensions and explicit missing-data states. Deterministic
voice and accessibility constraints do not claim to measure subjective quality,
taste, or user effort. Differentials are descriptive paired-scenario views and
make no statistical, causal, stability, latency, or product-ranking claim.

## Next boundary

Phase 3 includes a read-only episode foundation connected to the CLI and
append-only artifact writer. It can run versioned synthetic fixtures through a
bounded multi-round `read_file` loop and retain state snapshots, raw provider
responses, normalized candidate responses, timing, usage, and evaluator checks.

Behavioral mapping is implemented across control, protocol, agentic, state and
memory, and writing families. The next milestone is Phase 5 candidate
optimization, beginning with protected held-out isolation and a frozen,
interleaved experiment contract.
