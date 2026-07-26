/**
 * Compile-only contract for ADR-0030's persistent Phase 1 assistant-turn types.
 *
 * This file is included by `npm run typecheck`, but not by Vitest. It keeps the
 * accepted field names and discriminants visible to the compiler without
 * activating the new turn domain in any runtime path.
 */
import type {
  AssistantProseItem,
  AssistantReplayEvidence,
  AssistantToolCallItem,
  AssistantTurnRecord,
  AssistantTurnSegment,
  ProviderReplayCapsule,
  ProviderTurnCapabilities,
} from "../../src/shared/types";

const replayCapsule = {
  provider: "anthropic",
  version: 1,
  thinkingBlocks: [
    {
      type: "thinking",
      thinking: "Inspect the synthetic note.",
      signature: "sig_fixture_contract",
    },
    {
      type: "redacted_thinking",
      data: "redacted_fixture_contract",
    },
  ],
} satisfies ProviderReplayCapsule;

const segment = {
  id: "segment-contract",
  providerMessageId: "message-contract",
  replayCapsule,
} satisfies AssistantTurnSegment;

const prose = {
  type: "prose",
  id: "item-prose-contract",
  segmentId: segment.id,
  sourceItemId: "source-prose-contract",
  text: "Visible prose.",
  actionRef: "action-contract",
  actionAnchor: "parsed_edit",
} satisfies AssistantProseItem;

const tool = {
  type: "tool_call",
  id: "item-tool-contract",
  segmentId: segment.id,
  sourceItemId: "source-tool-contract",
  toolCallId: "call-contract",
  toolName: "read_file",
  toolArguments: "{\"path\":\"Fixtures/contract.md\"}",
  toolArgs: { path: "Fixtures/contract.md" },
  toolInput: "Fixtures/contract.md",
  state: "completed",
  resultRecord: "Synthetic result.",
  resultDigest: "[read_file: Fixtures/contract.md]",
  isError: false,
  actionRef: "tool-action-contract",
  askGuidance: {
    questions: [
      {
        question: "Continue?",
        header: "Decision",
        answer: "Yes",
      },
    ],
  },
  askStatus: "completed",
  round: 1,
} satisfies AssistantToolCallItem;

const turn = {
  schemaVersion: 1,
  id: "turn-contract",
  status: "completed",
  segments: [segment],
  items: [prose, tool],
} satisfies AssistantTurnRecord;

const capabilities = {
  captureOrder: "exact",
  toolCorrelation: "provider_id",
  coldReplay: "structural",
  nativeResume: false,
} satisfies ProviderTurnCapabilities;

const evidence = {
  tier: "structural",
  capabilities,
  loweredReason: "Synthetic contract evidence.",
} satisfies AssistantReplayEvidence;

void turn;
void evidence;
