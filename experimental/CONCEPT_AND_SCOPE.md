# Model behavior laboratory: concept and scope

## Status

This document is the charter for the experimental model behavior laboratory.
It records the motivation, intended capabilities, authority boundaries, and
evaluation principles of the suite. Implementation decisions should be checked
against this document as the laboratory evolves.

The laboratory lives under `experimental/` and is not part of the shipped
Obsidian plugin. Production code may be exercised by the laboratory, but code
under `src/` must never depend on experimental code.

## Motivation

Writing Assistant Chat provides a common interface across frontier services and
local models. The product works well enough for capable models, but local models
vary substantially in behavior even when they expose superficially compatible
APIs.

Relevant differences include:

- instruction following;
- exact text reproduction;
- chat templates and tokenizer behavior;
- tool-call syntax and argument quality;
- stop tokens and truncation;
- context retention;
- recovery after failed tool calls;
- sensitivity to prompt length and tool count;
- quantization and inference-engine behavior;
- sampling controls;
- writing quality and preservation of voice.

Conventional benchmarks cover only a small and predetermined portion of this
behavior. They can report whether a model passed a known case, but they are less
suited to discovering unfamiliar failure modes, diagnosing their causes, and
testing whether a proposed improvement generalizes.

The laboratory exists to close that gap.

## Core objective

Create a safe, reproducible experimental system that can discover model and
application failures, form a causal hypothesis, test a candidate improvement,
search for regressions, and preserve confirmed discoveries as durable tests.

The long-term loop is:

```text
Observe behavior
      |
      v
Discover or reproduce a failure
      |
      v
Classify the responsible layer
      |
      v
Form a minimal causal hypothesis
      |
      v
Generate a candidate change
      |
      v
Compare baseline and candidate
      |
      v
Challenge the result with held-out and adversarial cases
      |
      v
Produce an evidence report for human review
      |
      v
Preserve the discovery as a regression test
```

This is the intended meaning of recursive self-improvement in this project. The
system improves the application and improves its ability to evaluate future
changes. It does not autonomously redefine its goals or publish changes.

## What the laboratory is

The laboratory is an external research and validation suite for the plugin. It
should eventually be able to:

1. Exercise the real provider-independent request boundary.
2. Reproduce complete multi-round agentic episodes.
3. Run episodes against disposable synthetic vaults.
4. Capture complete and replayable execution traces.
5. Evaluate objective outcomes and subjective writing behavior.
6. Compare unchanged baselines with controlled candidate variants.
7. Generate mutations and adversarial scenarios from observed failures.
8. Build behavioral profiles for specific model configurations.
9. Propose prompt, schema, parsing, policy, or implementation changes.
10. Present evidence and uncertainty for human approval.

## What the laboratory is not

The laboratory is not:

- a feature exposed inside the normal plugin interface;
- a replacement for unit, integration, or release tests;
- a leaderboard based on one overall model score;
- a system that assumes every model failure is a prompt problem;
- a process that treats model judgments as objective truth;
- an autonomous publisher, release agent, or repository authority;
- permitted to experiment against a user's real vault;
- permitted to edit locked tests or lower acceptance thresholds to make a
  candidate pass;
- permitted to collect private vault content as training or evaluation data
  without explicit user consent.

## Governing principles

### Evidence before intuition

Prompt changes should be treated as hypotheses. A change is an improvement only
when controlled experiments show a useful effect without unacceptable
regressions.

### Diagnose the responsible layer

A malformed response may result from the provider, serializer, chat template,
parser, context construction, tool protocol, prompt, or model. The laboratory
must distinguish these layers before recommending a remedy.

### Exercise production behavior

Where safe and practical, the suite should import and exercise production
contracts and pure logic rather than copying their behavior into a separate
simulator. A duplicated model-facing pipeline would eventually drift from the
actual product and invalidate results.

### Isolation by construction

Model behavior is untrusted input. The default experimental environment must
make access to a real vault, unrestricted filesystem, shell, and unrelated
network services unavailable rather than relying on the model to avoid them.

### Reproducibility over anecdote

Every result must retain enough provenance to reproduce the conditions. Local
model names alone are not sufficient identifiers.

### Multiple dimensions, not one score

Correctness, safety, writing quality, efficiency, recovery, latency, and cost
can move independently. Results should preserve that structure.

### Humans retain authority

The suite may observe, analyze, generate tests, run experiments, and propose
changes. A human decides whether a candidate becomes part of the product.

## Dependency boundary

The dependency direction is one-way:

```text
experimental/  --->  src/
src/            -X-> experimental/
```

The laboratory may import stable contracts such as `ChatClient`, `ChatRequest`,
tool definitions, parsers, edit logic, and pure request-construction helpers.
The production bundle must not import laboratory runners, scenarios,
evaluators, artifacts, or model profiles.

Experimental dependencies should remain development-only and must not enter the
plugin's runtime bundle.

## Experimental subject identity

A local model experiment must identify the complete runtime configuration, not
only the model label. Subject identity should eventually include:

- model family and exact artifact;
- parameter count where known;
- quantization and quantization format;
- model file hash where practical;
- inference engine and version;
- chat template;
- tokenizer identity;
- context-window configuration;
- GPU and CPU offload configuration when behaviorally relevant;
- speculative decoding or other acceleration settings;
- sampling parameters;
- reasoning mode;
- provider adapter and endpoint version.

A behavioral claim applies to this configuration. It should not automatically
be generalized to every artifact carrying the same model family name.

## Failure taxonomy

The validator should classify a failure before attempting to optimize it.

### Transport and availability

Examples: endpoint unavailable, request timeout, connection loss, invalid model
identifier, or server overload.

### Serialization and template

Examples: incorrect role formatting, incompatible chat template, malformed tool
schema conversion, or tokenizer-specific corruption.

### Generation termination

Examples: wrong stop token, premature end, context exhaustion, repeated output,
or maximum-token truncation.

### Parsing and normalization

Examples: the model emitted a recoverable call that the adapter rejected, a
response was normalized incorrectly, or valid edit syntax was parsed
incorrectly.

### Tool protocol

Examples: wrong tool selection, missing arguments, invented tools, duplicate
calls, invalid ordering, or failure to use tool results.

### Context and state

Examples: forgotten instructions, confusion between current and historical
document state, rejected edits treated as accepted, or wrong-file targeting.

### Instruction following

Examples: ignored constraints, excessive commentary, failure to ask for needed
information, or attempting an action the user did not authorize.

### Task quality

Examples: weak writing, loss of voice, factual errors, poor revision choices,
or unhelpful explanation despite protocol compliance.

### Evaluator failure

Examples: an assertion encoded the wrong expected state, a qualitative rubric
was ambiguous, or a judge preferred a response for irrelevant stylistic
reasons.

Evaluator failures are first-class failures. They must not be silently counted
against the model.

## Evaluation hierarchy

Evaluation should use the least subjective reliable method available.

### 1. Deterministic assertions

Use for exact protocol and state properties:

- required tool called;
- forbidden tool not called;
- arguments satisfy a schema;
- response contains or excludes required material;
- number of attempts stays within a limit;
- no path escapes the synthetic vault;
- expected file exists after the episode;
- forbidden file remains unchanged.

### 2. State-transition evaluation

Judge the resulting state rather than surface syntax. For example, several
valid edit sequences may produce the same correct synthetic-vault state.

### 3. Invariant and metamorphic evaluation

Transform a scenario in ways that should preserve behavior and check whether
the result remains stable. Useful transformations include:

- rename irrelevant files;
- reorder unrelated context;
- paraphrase the user request without changing intent;
- vary whitespace or harmless metadata;
- move the target note within the permitted scope;
- add distractor notes;
- replace names and concrete nouns;
- change document length while preserving the tested relationship.

These tests reveal brittle prompt matching and hidden assumptions.

### 4. Differential evaluation

Run the same scenario across model configurations, prompt variants,
serializers, or tool surfaces. Differences help isolate the cause of a failure.

### 5. Blind qualitative evaluation

Use for writing quality and usefulness when deterministic checks are
insufficient. Candidate identity, model identity, and ordering should be hidden
from the judge. Prefer focused rubrics and pairwise comparisons over broad
numeric scores.

### 6. Human evaluation

Use for ambiguous questions of voice, taste, accessibility, and whether a
trade-off is desirable for actual writers. Human judgment is the final arbiter
for product direction.

## Evaluation dimensions

Results should be represented as a vector rather than collapsed immediately
into one score.

### Correctness

Did the model understand and complete the requested task?

### Safety and scope adherence

Did it stay within authorized files, actions, tools, and task boundaries?

### Protocol reliability

Did it use the request, response, editing, and tool protocols correctly?

### State awareness

Did it correctly understand the current document, conversation history, prior
tool outcomes, and accepted or rejected changes?

### Recovery behavior

Did it interpret errors correctly, avoid loops, and choose a useful next step?

### Writing quality

Did the result improve clarity, structure, style, or usefulness according to
the task-specific rubric?

### Voice preservation

Did it preserve the author's established voice when preservation was required?

### User effort

How much clarification, correction, review, or manual repair would a user need?

### Efficiency

How many rounds, tool calls, tokens, and seconds were required?

### Robustness

Does the behavior persist across repetitions and semantically equivalent
scenario variants?

## Writing-quality evaluation

Writing tasks rarely have one correct answer. The suite must not pretend that
subjective quality is deterministic.

Preferred methods are:

- blind pairwise comparison between baseline and candidate;
- narrow rubrics such as clarity, voice preservation, continuity, and adherence
  to requested constraints;
- separate judgments for each rubric dimension;
- several independent judgments for close decisions;
- explicit uncertainty or ties;
- human review of disputed or product-defining preferences.

Edit acceptance and rejection history may inspire scenarios, but it must not be
treated automatically as reward data. A user may reject a good edit because
their intent changed, because one portion was wrong, or because they preferred
another valid direction.

## Scenario classes

The suite should grow through distinct scenario families.

### Controls

Small cases that verify the laboratory, model endpoint, and evaluator are
working. A failed control can invalidate the rest of a run.

### Protocol cases

Focused tests for formatting, tool selection, argument construction, parsing,
and termination behavior.

### Agentic episodes

Multi-round tasks that require observation, planning, tool use, error recovery,
and completion against a synthetic vault.

### State and memory cases

Tests for long conversations, accepted and rejected changes, interruption,
branching, context truncation, and stale state.

### Writing cases

Revision, critique, expansion, compression, ideation, continuity, structural
editing, nonfiction assistance, and preservation of authorial voice.

### Accessibility cases

Tasks involving unclear requests, inexperienced users, incomplete terminology,
or users who need useful guidance without knowing the application's internal
concepts.

### Adversarial cases

Path confusion, distracting context, conflicting instructions, malformed tool
results, repeated failures, deceptive fixture content, and outputs designed to
mislead naive evaluators.

### Regression cases

Minimized reproductions of failures discovered in real experiments. Every
confirmed failure should become a durable regression case when it can be
represented without private user data.

### Held-out cases

Protected scenarios used only to challenge candidate changes. Candidate
generation must not inspect or modify these cases.

## Scenario lifecycle

Each scenario should move through an explicit lifecycle:

1. Drafted from a product requirement, known risk, or observed failure.
2. Reviewed for a clear target behavior and valid fixture.
3. Validated against known-good and known-bad traces.
4. Classified as visible development, adversarial, regression, control, or
   held-out.
5. Versioned when the fixture, request, or acceptance contract changes.
6. Retired only with a recorded reason.

Scenario changes can alter historical meaning. Reports must identify the exact
scenario version.

## Trace and artifact contract

Every trial should produce a self-contained trace. The exact schema will evolve,
but provenance should eventually include:

- trace schema version;
- run and trial identifiers;
- scenario identifier and version;
- source revision;
- model subject identity;
- provider and adapter identity;
- complete sampling configuration;
- system prompt and prompt-component hashes;
- tool-definition and tool-surface hashes;
- exact request messages and context;
- raw model responses;
- parsed tool calls;
- tool results and structured failures;
- intermediate synthetic-vault states;
- final synthetic-vault diff;
- token usage, cost when available, and timing;
- stop reason and truncation state;
- evaluator versions and individual checks;
- overall disposition and uncertainty;
- timeout, cancellation, transport, and evaluator errors.

Raw artifacts should be append-only for a completed experiment. Summaries may be
regenerated from traces, but a summary must not replace the underlying evidence.

## Sandbox model

### Current completion sandbox

The initial vertical slice invokes only the provider-independent completion
boundary. It receives a `ChatClient`, records the response, and evaluates it.
It has no tool handler registry, vault object, shell, or direct artifact path.
Tool calls are captured but cannot execute.

### Future episode sandbox

The agentic runner should use a fresh disposable fixture for every trial:

- initialize from a versioned synthetic-vault fixture;
- provide a virtual or overlay filesystem rooted at that fixture;
- normalize and enforce every path at the sandbox boundary;
- deny access outside the fixture root;
- expose only the tools named by the scenario;
- record every read, proposed write, error, and state transition;
- cap tool rounds, repeated calls, output size, duration, and token use;
- disable unrelated network access;
- destroy or archive the fixture according to the artifact policy;
- compare the final state with declared invariants.

No laboratory scenario should receive a real vault path. Real user material may
only enter a research dataset through a separate, explicit, privacy-reviewed
process.

## Candidate changes

The laboratory may eventually experiment with candidates in several classes:

- system-prompt components;
- tool descriptions and strategy guidance;
- tool-set size and progressive disclosure;
- provider formatting and normalization;
- chat-template selection;
- parsing and recovery behavior;
- context selection and history representation;
- sampling defaults;
- model-specific compatibility profiles;
- implementation changes in pure production logic.

A candidate must declare the component it changes. Experiments should vary one
causal factor at a time whenever practical.

## Baseline and candidate comparison

A candidate experiment should:

1. Freeze the baseline configuration.
2. Declare the exact candidate delta.
3. Randomize or interleave baseline and candidate trials when ordering effects
   are possible.
4. Use repeated trials for stochastic models.
5. Apply identical scenario inputs and resource limits.
6. Compare each evaluation dimension.
7. Report effect size and uncertainty, not only pass percentages.
8. Run visible development scenarios.
9. Run protected held-out scenarios.
10. Generate fresh adversarial variants after the candidate exists.
11. Produce a report containing improvements, regressions, inconclusive results,
    cost, and latency changes.

Candidate identity should be hidden from qualitative judges.

## Acceptance gates

A candidate must not be accepted merely because its aggregate score increased.
Each experiment should define gates before it runs.

An example gate is:

> Improve edit-tool completion reliability by at least the declared margin,
> introduce no critical safety regression, preserve state-awareness performance,
> and keep writing-quality and latency changes within their allowed bounds.

Gate categories should include:

- minimum target improvement;
- zero-tolerance safety invariants;
- maximum permitted regression in protected dimensions;
- required confidence or repetition count;
- held-out performance;
- evaluator validity;
- resource-budget compliance;
- human approval requirement.

Failed candidates remain useful evidence. Their traces should be retained.

## Behavioral model profiles

The suite should build evidence-backed profiles rather than rank models on one
axis. A profile may describe reliability for:

- exact copying;
- structured output;
- tool selection;
- tool argument validity;
- multi-round planning;
- recovery from errors;
- rejected-edit awareness;
- long-context retention;
- style preservation;
- verbosity control;
- hallucination under missing context;
- sensitivity to tool count;
- sensitivity to prompt phrasing;
- sampling stability.

These profiles can eventually guide compatibility presets. A smaller model may
perform better with fewer tools and explicit sequencing, while another may be
reliable with a broad tool surface and lighter guidance. The goal is empirical
adaptation, not a growing collection of untested model-name exceptions.

## Validator role

Codex or another capable validator may act in several separated roles:

### Investigator

Reads traces, groups failures, identifies suspicious layers, and proposes
discriminating experiments.

### Scenario designer

Creates minimized reproductions, metamorphic variants, and adversarial cases.

### Candidate designer

Proposes the smallest prompt, schema, policy, or implementation change that
tests a causal hypothesis.

### Qualitative judge

Performs blind pairwise evaluation using a narrow rubric. This role should not
receive candidate identity or the investigator's preferred conclusion.

### Auditor

Checks whether the experiment, evaluator, and reported conclusion are supported
by the recorded evidence.

These roles may use the same underlying model in separate stateless runs, but
that does not make them fully independent. Deterministic checks and human review
remain necessary.

## Recursive improvement of the validator

The validator itself is subject to evaluation.

- A newly discovered model failure becomes a regression scenario.
- An evaluator mistake becomes an evaluator regression test.
- A vague rubric is replaced with a more discriminating rubric.
- A blind spot motivates a new scenario family or mutation operator.
- A misleading aggregate metric is decomposed into clearer dimensions.
- A non-reproducible result strengthens the provenance contract.
- A sandbox escape attempt strengthens an invariant at the boundary.

The validator must not improve itself by deleting difficult cases, inspecting
locked answers, changing success criteria after observing results, or promoting
its own candidates.

Known-good, known-bad, ambiguous, and deliberately deceptive traces should be
maintained as evaluator canaries.

## Authority levels

Laboratory authority should increase only after evidence that the preceding
level is reliable.

### Level 1: Observe

Run scenarios, capture traces, and report behavior.

### Level 2: Diagnose

Classify failures and propose causal experiments.

### Level 3: Expand evaluation

Generate candidate scenarios and regression tests for human review.

### Level 4: Experiment

Generate bounded candidate variants and compare them with the baseline.

### Level 5: Propose changes

Produce candidate patches and evidence reports without applying them to the
accepted product state.

### Level 6: Limited automatic promotion

Potential future capability for narrowly scoped, low-risk changes with strict
gates. This level is out of current scope and requires a separate authorization
decision.

At every level, committing, merging, publishing, releasing, changing protected
tests, and redefining acceptance criteria remain human-controlled actions.

## Privacy and data policy

The laboratory should default to synthetic fixtures and public or deliberately
authored evaluation material.

If real usage traces are considered later:

- collection must be explicit and opt-in;
- users must understand what is retained and why;
- secrets and personal data must be removed;
- minimization should occur before long-term storage;
- raw private content must not be sent to unrelated providers;
- retention and deletion rules must be documented;
- derived regression cases should be rewritten into synthetic forms whenever
  possible.

No telemetry or silent collection is part of this concept.

## Risks and countermeasures

### Benchmark overfitting

Countermeasures: protected held-out cases, fresh mutations, adversarial cases,
and periodic scenario renewal.

### Goodhart's law

Countermeasures: multiple dimensions, explicit safety gates, human review, and
retaining raw evidence.

### Judge bias and self-preference

Countermeasures: blind pairwise judgments, focused rubrics, evaluator canaries,
multiple judgments, and deterministic checks where possible.

### Stochastic false conclusions

Countermeasures: repeated trials, interleaved comparisons, uncertainty reports,
and avoiding claims unsupported by sample size.

### Configuration drift

Countermeasures: complete subject identity, prompt and schema hashes, source
revision, and immutable run conditions.

### Simulator drift

Countermeasures: reuse production contracts and pure logic, plus parity tests
between laboratory and live request construction.

### Unsafe model actions

Countermeasures: capability-based sandboxing, path enforcement, disposable
fixtures, resource limits, and no real-vault access.

### Mistaking protocol defects for model weakness

Countermeasures: layered failure taxonomy and counterfactual replay across
serializers, templates, parsers, and prompts.

### Accumulating prompt complexity

Countermeasures: minimal causal changes, prompt-component ownership, token-cost
measurement, and removal experiments for obsolete guidance.

## Phased roadmap

### Phase 1: Completion trace foundation

Status: initial vertical slice implemented.

- provider-independent completion runner;
- bounded repetitions and timeout;
- immutable request and response capture;
- deterministic evaluators;
- evaluator-error visibility;
- injected artifact sink;
- control scenario;
- no tool execution or filesystem authority.

### Phase 2: Reproducible local execution

- command-line entry point outside the plugin;
- explicit LM Studio endpoint and model selection;
- model and runtime metadata capture;
- artifact writer restricted to `experimental/artifacts/`;
- endpoint health control;
- baseline report generation.

### Phase 3: Disposable-vault episode runner

- versioned synthetic-vault fixtures;
- overlay or virtual filesystem;
- real tool definitions and handlers adapted to the sandbox;
- complete multi-round tool loop;
- state snapshots and final diffs;
- hard path, round, time, token, and repetition limits;
- injected failures and recovery cases.

### Phase 4: Behavioral mapping

- protocol and tool-use scenario families;
- memory and edit-state scenarios;
- writing and accessibility scenarios;
- multidimensional model profiles;
- repeated-run stability measurements;
- differential experiments across configurations.

### Phase 5: Candidate optimization

- explicit prompt and schema component variants;
- frozen baselines;
- randomized baseline-versus-candidate runs;
- effect and regression reports;
- blind qualitative comparison;
- protected held-out suite.

### Phase 6: Recursive discovery

- trace clustering;
- failure minimization;
- scenario mutation;
- adversarial evaluator challenges;
- candidate generation;
- automatic regression-case proposals;
- evaluator canary suite.

### Phase 7: Product feedback

- human-reviewed compatibility profiles;
- evidence-backed default changes;
- release gates for critical behavioral regressions;
- documented model-specific guidance only where evidence supports it.

Automatic integration or publication is not authorized by this roadmap.

## Definition of success

The laboratory is successful when it can answer questions such as:

- Is this failure caused by the model, adapter, parser, prompt, or tool surface?
- Can the behavior be reproduced reliably?
- What is the smallest change that affects it?
- Does the candidate improve the target behavior across repetitions?
- Does it generalize to equivalent and adversarial cases?
- What did it make worse?
- Is the conclusion supported by objective state and complete traces?
- What model configurations benefit from the change?
- How much additional user effort, latency, or compute does it require?
- Should a human accept the candidate into the product?

Success is not an ever-increasing benchmark number. Success is a trustworthy
process for turning uncertain model behavior into reproducible knowledge and
evidence-backed product improvements.

## Current scope boundary

The currently implemented suite covers Phases 1 and 2, plus the read-only
foundation of Phase 3. It can invoke a supplied `ChatClient`, perform bounded
non-streaming completions, run through a dedicated local command-line
interface, preflight an LM Studio endpoint and model, capture native model
metadata, persist append-only evidence, and generate readable reports. It can
also run repeated, bounded multi-round episodes against a versioned in-memory
synthetic vault using a sandbox-only `read_file` handler. Grouped episode runs
freeze their conditions before execution and retain self-contained traces,
state snapshots, raw and normalized responses, provenance, timing, usage, and
derived summaries. It cannot yet:

- execute any write tool or mutate a disposable vault;
- perform qualitative model judging;
- generate candidate improvements;
- maintain held-out scenarios;
- promote any change into the plugin.

These omissions are intentional safety and sequencing boundaries, not claims
that the larger concept is complete.

## Decision record

The following decisions are foundational unless explicitly revised:

1. The laboratory remains outside the shipped application.
2. Production code never depends on `experimental/`.
3. Experiments use synthetic disposable vaults, never a real vault.
4. Tool execution is unavailable until the isolated episode sandbox exists.
5. Every candidate is compared with a frozen baseline.
6. Raw evidence is retained alongside summaries.
7. Evaluation uses several methods and dimensions.
8. Evaluator failures are visible and testable.
9. Held-out criteria cannot be modified by candidate generation.
10. Humans retain authority over accepted product changes and publication.
