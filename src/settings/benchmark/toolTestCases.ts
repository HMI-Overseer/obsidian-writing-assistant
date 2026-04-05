import { TOOL_EDIT_SYSTEM_PROMPT } from "../../tools/editing/systemPrompt";
import { ALL_EDIT_TOOLS, CORE_EDIT_TOOLS } from "../../tools/editing/definition";
import {
  evaluateBasicToolCall,
  evaluateInspectBeforeEdit,
  evaluateCorrectToolSelection,
  evaluateSearchPrecision,
  evaluateMultipleEdits,
  evaluateCoreToolsFallback,
} from "./toolEvaluator";
import type { BenchmarkTestCase } from "./types";

// =========================================================================
// Fixture: simple document for tool-call tests
// =========================================================================

const TOOL_TEST_DOC = `---
title: The Blacksmith's Forge
tags: [fiction, draft]
status: in-progress
---

# The Blacksmith's Forge

The forge sat at the edge of the village, smoke curling from its chimney at all hours. Kael had worked the anvil since he was twelve, learning the rhythm of hammer and steel from his father before him.

## Morning Routine

Each day began before dawn. Kael would rake the coals, pump the bellows until the fire glowed white-hot, and lay out his tools in the same careful order: tongs first, then hammers lightest to heaviest, then the quenching bucket filled with fresh water from the well.

## The Commission

The mayor had ordered a new gate for the town square — wrought iron, twelve feet tall, with ivy patterns along the top rail. It was the largest piece Kael had ever attempted, and he had spent three nights sketching designs before touching metal.

## Evening

When the last light faded, Kael banked the fire and swept the floor. He hung his apron on the hook by the door and stepped into the cool evening air. The village was quiet. Stars emerged one by one above the thatched rooftops.`;

// =========================================================================
// Test cases
// =========================================================================

export function getToolTestCases(): BenchmarkTestCase[] {
  return [
    {
      id: "tool-basic-call",
      name: "Basic tool call",
      description:
        "Model should respond with at least one apply_edit tool call when asked to edit a passage. " +
        "Validates that the model uses tools rather than outputting raw text edits.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Change 'twelve feet tall' to 'fourteen feet tall' in the commission section." },
      ],
      evaluate: evaluateBasicToolCall,
      criteria: {
        expectedOutcome: "Model produces at least one apply_edit tool call with valid search and replace arguments.",
        targetKeywords: ["twelve feet tall"],
        targetLabel: "Text to edit in commission section",
        notes: "Tests that the model uses tool calls instead of outputting raw SEARCH/REPLACE blocks.",
      },
    },
    {
      id: "tool-inspect-before-edit",
      name: "Inspect before edit",
      description:
        "Model should call get_document_outline or get_line_range before making edits. " +
        "The system prompt instructs inspection first — this tests compliance.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Can you make the morning routine section more vivid and atmospheric?" },
      ],
      evaluate: evaluateInspectBeforeEdit,
      criteria: {
        expectedOutcome: "Model calls get_document_outline or get_line_range as its first tool call, before any edit tools.",
        requiredMentions: ["get_document_outline", "get_line_range"],
        notes: "Only checks the first tool call. The model may or may not also produce edit calls in the same response.",
      },
    },
    {
      id: "tool-correct-selection",
      name: "Correct tool for frontmatter",
      description:
        "When asked to modify frontmatter, model should use update_frontmatter rather than apply_edit.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Change the status in the frontmatter from 'in-progress' to 'complete' and remove the tags field." },
      ],
      evaluate: evaluateCorrectToolSelection,
      criteria: {
        expectedOutcome: "Model uses update_frontmatter tool (not apply_edit) to modify frontmatter properties.",
        targetKeywords: ["update_frontmatter"],
        targetLabel: "Correct tool for frontmatter changes",
        forbiddenKeywords: ["apply_edit"],
        forbiddenLabel: "Wrong tool for frontmatter",
      },
    },
    {
      id: "tool-search-precision",
      name: "Search text precision",
      description:
        "Model's apply_edit search text should be short and precise — not the entire document or large sections.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "In the evening section, change 'thatched rooftops' to 'slate rooftops'." },
      ],
      evaluate: evaluateSearchPrecision,
      criteria: {
        expectedOutcome: "Model's apply_edit search text is under 200 characters and contains the target phrase.",
        targetKeywords: ["thatched rooftops"],
        targetLabel: "Target phrase in evening section",
        notes: "Search text should be short (target + a few surrounding lines for context), not a full section or document.",
      },
    },
    {
      id: "tool-multiple-edits",
      name: "Multiple distinct edits",
      description:
        "When asked to make several changes, model should produce multiple separate tool calls — one per edit.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Make these three changes: (1) change 'twelve' to 'fourteen' in the title, (2) change 'white-hot' to 'cherry-red' in morning routine, (3) change 'thatched' to 'slate' in the evening section." },
      ],
      evaluate: evaluateMultipleEdits,
      criteria: {
        expectedOutcome: "Model produces at least 3 edit tool calls (apply_edit or replace_section), one for each requested change.",
        targetKeywords: ["fourteen", "cherry-red", "slate"],
        targetLabel: "Three distinct replacements",
      },
    },
    {
      id: "tool-core-fallback",
      name: "Core tools — limited schema",
      description:
        "With only core tools (apply_edit + insert_at_position), model should still produce valid edits. " +
        "Tests that the model adapts when the full tool set isn't available.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: CORE_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Change 'twelve feet tall' to 'fourteen feet tall' in the commission section." },
      ],
      evaluate: evaluateCoreToolsFallback,
      criteria: {
        expectedOutcome: "Model produces a valid apply_edit tool call even with the limited (core) tool set.",
        targetKeywords: ["twelve feet tall"],
        targetLabel: "Text to edit",
        notes: "Only apply_edit and insert_at_position are available. Model should not hallucinate other tools.",
      },
    },
  ];
}
