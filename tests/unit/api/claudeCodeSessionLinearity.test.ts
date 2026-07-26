import { describe, it, expect } from "vitest";
import { ClaudeCodeClient, type SdkSessionTurnInput } from "../../../src/api/ClaudeCodeClient";
import {
  diagnoseSessionReuse,
  fingerprint,
  hashPrefix,
  type HarnessSession,
  type SessionConfig,
  type SessionTurn,
} from "../../../src/api/harnessSession";
import { toHistoryTurns } from "../../../src/chat/finalization/prepareApiMessages";
import type { ChatRequest, ChatTurn } from "../../../src/shared/chatRequest";
import type {
  AgenticStep,
  AssistantTurnRevision,
  ConversationMessage,
  SamplingParams,
} from "../../../src/shared/types";

/**
 * Session linearity across annotated edit turns.
 *
 * The live-session watermark hashes the assistant reply as the raw streamed text
 * (SdkSession.advanceWatermark). On the next send, prepareApiMessages rewrites
 * edit-turn content with accept/reject annotations for the model's benefit, which
 * used to make the linearity hash miss every turn after an edit ("history edited"
 * cold rebuild on back-to-back edits). Tool-call edit turns received their real
 * dispositions in-band (LiveVaultReview resolves each call's tool result), so the
 * annotation is presentation-only there: ChatTurn.rawContent carries the raw
 * persisted text, and the client builds the session turns from it.
 */

const RAW_USER = "Tighten the intro of chapter 3.";
const RAW_REPLY = "Done. I trimmed the opening paragraph.";
const ANNOTATED_REPLY =
  RAW_REPLY +
  '\n\n[Edit in chapter-3.md: "The opening", ACCEPTED]' +
  "\n\n[Edit outcome: 1 accepted, 0 rejected out of 1 proposed changes]";

function cfg(): SessionConfig {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "Be concise.",
    reasoning: "off",
    agenticMode: true,
    toolNames: ["propose_edit"],
  };
}

/** A session watermark advanced from the RAW streamed reply, what advanceWatermark hashes. */
function watermarkMeta(config: SessionConfig): HarnessSession {
  const covered: SessionTurn[] = [
    { role: "user", content: RAW_USER },
    { role: "assistant", content: RAW_REPLY },
  ];
  return {
    provider: "claudecode",
    model: config.model,
    coveredCount: covered.length,
    prefixHash: hashPrefix(covered, covered.length),
    configFingerprint: fingerprint(config),
    config,
  };
}

function watermarkFor(config: SessionConfig, assistantText: string): HarnessSession {
  const covered: SessionTurn[] = [
    { role: "user", content: RAW_USER },
    { role: "assistant", content: assistantText },
  ];
  return {
    provider: "claudecode",
    model: config.model,
    coveredCount: covered.length,
    prefixHash: hashPrefix(covered, covered.length),
    configFingerprint: fingerprint(config),
    config,
  };
}

function chainMessage(
  origin: AssistantTurnRevision["origin"] = "generated",
  closingText = "After.",
): ConversationMessage {
  return {
    id: "chain-assistant",
    role: "assistant",
    content: "stale display text",
    revisions: [
      {
        revisionId: "chain-revision",
        kind: "turn",
        origin,
        ...(origin === "edited"
          ? { parentRevisionId: "source-revision" }
          : {}),
        createdAt: 1,
        provider: "claudecode",
        modelId: cfg().model,
        turn: {
          schemaVersion: 1,
          id: "chain-turn",
          status: "completed",
          segments: [{ id: "s1" }, { id: "s2" }],
          items: [
            {
              type: "prose",
              id: "p1",
              segmentId: "s1",
              text: "Before.",
            },
            {
              type: "tool_call",
              id: "t1",
              segmentId: "s1",
              toolCallId: "call-1",
              toolName: "read_file",
              toolArguments: '{"path":"chapter.md"}',
              toolArgs: { path: "chapter.md" },
              toolInput: "chapter.md",
              state: "completed",
              resultRecord: "bounded result",
            },
            {
              type: "prose",
              id: "p2",
              segmentId: "s2",
              text: closingText,
            },
          ],
        },
      },
    ],
    activeRevisionId: "chain-revision",
  };
}

function makeRequest(messages: ChatTurn[]): ChatRequest {
  return { systemPrompt: "", documentContext: null, ragContext: null, messages };
}

/** Runs one turn through a capturing session stub and returns the input the client built. */
async function captureTurnInput(messages: ChatTurn[]): Promise<SdkSessionTurnInput> {
  let captured: SdkSessionTurnInput | undefined;
  const client = new ClaudeCodeClient("claude", {
    useSdk: true,
    sdkSession: {
      conversationId: "c1",
      run: (input) => {
        captured = input;
        return (async function* () {
          yield "ok";
        })();
      },
    },
  });
  await client.complete(makeRequest(messages), cfg().model, { reasoning: "off" } as SamplingParams);
  if (!captured) throw new Error("session stub was never invoked");
  return captured;
}

describe("Claude Code session linearity across edit annotations", () => {
  it("reuses the live session when the annotated turn carries rawContent (tool-call edits)", async () => {
    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      { role: "assistant", content: ANNOTATED_REPLY, rawContent: RAW_REPLY },
      { role: "user", content: "Now do the outro." },
    ]);
    expect(diagnoseSessionReuse(watermarkMeta(cfg()), input.turns, cfg())).toEqual({
      reuse: true,
    });
  });

  it("still rebuilds when the raw content itself was edited (a real history edit)", async () => {
    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      { role: "assistant", content: ANNOTATED_REPLY, rawContent: "Something the model never said." },
      { role: "user", content: "Now do the outro." },
    ]);
    expect(diagnoseSessionReuse(watermarkMeta(cfg()), input.turns, cfg())).toEqual({
      reuse: false,
      reason: "history-edited",
    });
  });

  it("still rebuilds for annotated turns without rawContent (regex edits: outcomes ride the replay)", async () => {
    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      { role: "assistant", content: ANNOTATED_REPLY },
      { role: "user", content: "Now do the outro." },
    ]);
    expect(diagnoseSessionReuse(watermarkMeta(cfg()), input.turns, cfg())).toEqual({
      reuse: false,
      reason: "history-edited",
    });
  });

  it("reuses the live session across an agentic-digest annotated claudecode turn (section 5 drift canary)", async () => {
    // Phase 3 resolution A: the agentic digest rides `content`, the raw streamed
    // bytes stay in `rawContent`, so the linearity hash still matches the watermark.
    // The pinning mutation (routing the digest into rawContent) makes this go red
    // with a `history-edited` rebuild.
    const steps: AgenticStep[] = [
      { type: "tool_call", round: 0, toolName: "read_file", toolInput: "chapter-3.md", resultRecord: "text" },
      {
        type: "tool_call",
        round: 0,
        toolName: "create_directory",
        toolInput: "Drafts/Arcs",
        disposition: "declined",
      },
    ];
    const message: ConversationMessage = {
      id: "a1",
      role: "assistant",
      content: RAW_REPLY,
      provider: "claudecode",
      agenticSteps: steps,
    };
    const [annotated] = toHistoryTurns(message, false, "claudecode");
    expect(annotated.content).not.toBe(RAW_REPLY); // the digest was appended
    expect(annotated.rawContent).toBe(RAW_REPLY); // raw bytes preserved for the hash

    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      annotated,
      { role: "user", content: "Now do the outro." },
    ]);
    expect(diagnoseSessionReuse(watermarkMeta(cfg()), input.turns, cfg())).toEqual({ reuse: true });
  });

  it("keeps the annotated content in the cold-mint full prompt", async () => {
    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      { role: "assistant", content: ANNOTATED_REPLY, rawContent: RAW_REPLY },
      { role: "user", content: "Now do the outro." },
    ]);
    // A genuinely cold rebuild has no in-band tool results to know outcomes from,
    // so the replayed transcript must keep the annotations.
    expect(input.fullPrompt).toContain("[Edit outcome: 1 accepted, 0 rejected");
  });

  it("hashes exact assistantRawReplayText bytes for a chain-backed Claude turn", async () => {
    const [annotated] = toHistoryTurns(
      chainMessage(),
      false,
      "claudecode",
    );

    expect(annotated.content).toContain("[read_file: chapter.md");
    expect(annotated.rawContent).toBe("Before.After.");

    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      annotated,
      { role: "user", content: "Continue." },
    ]);
    expect(
      diagnoseSessionReuse(
        watermarkFor(cfg(), "Before.After."),
        input.turns,
        cfg(),
      ),
    ).toEqual({ reuse: true });
  });

  it("invalidates native continuation at an edited chain revision", async () => {
    const [edited] = toHistoryTurns(
      chainMessage("edited", "Changed by the user."),
      false,
      "claudecode",
    );
    const input = await captureTurnInput([
      { role: "user", content: RAW_USER },
      edited,
      { role: "user", content: "Continue." },
    ]);

    expect(
      diagnoseSessionReuse(
        watermarkFor(cfg(), "Before.After."),
        input.turns,
        cfg(),
      ),
    ).toEqual({
      reuse: false,
      reason: "history-edited",
    });
  });
});
