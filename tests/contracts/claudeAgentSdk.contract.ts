/**
 * Compile-only consumer contract for the Claude Agent SDK.
 *
 * This file is included by `npm run typecheck`, but not by Vitest. It encodes
 * only the SDK surface the plugin consumes, so an SDK update fails locally when
 * an option, input message, query signature, or handled output shape changes.
 * Nothing in this file is executed, no CLI process or provider request starts.
 */
import { query } from "../../src/api/sdk/claudeAgentSdk";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "../../src/api/sdk/claudeAgentSdk";

type Assert<T extends true> = T;

const options = {
  abortController: new AbortController(),
  cwd: "C:/vault",
  pathToClaudeCodeExecutable: "C:/bin/claude.exe",
  model: "claude-sonnet-4-6",
  resume: "session-id",
  settingSources: [],
  includePartialMessages: true,
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "Plugin instructions",
  },
  effort: "high",
  env: { PATH: "C:/bin" },
  tools: [],
} satisfies Options;

const userMessage = {
  type: "user",
  message: { role: "user", content: "Hello" },
  parent_tool_use_id: null,
} satisfies SDKUserMessage;

type SuccessResult = Extract<SDKMessage, { type: "result"; subtype: "success" }>;
type ErrorResult = Extract<SDKMessage, { type: "result"; subtype: "error_during_execution" }>;
type CompactBoundary = Extract<SDKMessage, { type: "system"; subtype: "compact_boundary" }>;
type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>;

type _SuccessResultContract = Assert<
  SuccessResult extends {
    result: string;
    total_cost_usd: number;
    session_id: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  }
    ? true
    : false
>;

type _ErrorResultContract = Assert<
  ErrorResult extends { errors: string[]; is_error: boolean; session_id: string }
    ? true
    : false
>;

type _CompactBoundaryContract = Assert<
  CompactBoundary extends {
    compact_metadata: { trigger: "manual" | "auto"; pre_tokens: number };
    session_id: string;
  }
    ? true
    : false
>;

type _StreamEventContract = Assert<
  StreamEvent extends { event: { type: string }; session_id: string } ? true : false
>;

async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield userMessage;
}

function queryContract(): Query {
  return query({ prompt: prompt(), options });
}

void queryContract;
