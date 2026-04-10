import { TOOL_EDIT_SYSTEM_PROMPT } from "../../tools/editing/systemPrompt";
import { ALL_EDIT_TOOLS } from "../../tools/editing/definition";
import {
  evaluateBasicToolCall,
  evaluateCorrectToolSelection,
  evaluateSearchPrecision,
  evaluateMultipleEdits,
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
        "Model should respond with at least one propose_edit tool call when asked to edit a passage. " +
        "Validates that the model uses tools rather than outputting raw text edits.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Change 'twelve feet tall' to 'fourteen feet tall' in the commission section." },
      ],
      evaluate: evaluateBasicToolCall,
      criteria: {
        expectedOutcome: "Model produces at least one propose_edit tool call with valid search and replace arguments.",
        targetKeywords: ["twelve feet tall"],
        targetLabel: "Text to edit in commission section",
        notes: "Tests that the model uses tool calls instead of outputting raw SEARCH/REPLACE blocks.",
      },
    },
    {
      id: "tool-correct-selection",
      name: "Correct tool for frontmatter",
      description:
        "When asked to modify frontmatter, model should use update_frontmatter rather than propose_edit.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "Change the status in the frontmatter from 'in-progress' to 'complete' and remove the tags field." },
      ],
      evaluate: evaluateCorrectToolSelection,
      criteria: {
        expectedOutcome: "Model uses update_frontmatter tool (not propose_edit) to modify frontmatter properties.",
        targetKeywords: ["update_frontmatter"],
        targetLabel: "Correct tool for frontmatter changes",
        forbiddenKeywords: ["propose_edit"],
        forbiddenLabel: "Wrong tool for frontmatter",
      },
    },
    {
      id: "tool-search-precision",
      name: "Search text precision",
      description:
        "Model's propose_edit search text should be short and precise — not the entire document or large sections.",
      document: TOOL_TEST_DOC,
      systemPromptSuffix: TOOL_EDIT_SYSTEM_PROMPT,
      tools: ALL_EDIT_TOOLS,
      messages: [
        { role: "user", content: "In the evening section, change 'thatched rooftops' to 'slate rooftops'." },
      ],
      evaluate: evaluateSearchPrecision,
      criteria: {
        expectedOutcome: "Model's propose_edit search text is under 200 characters and contains the target phrase.",
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
        expectedOutcome: "Model produces at least 3 edit tool calls (propose_edit), one for each requested change.",
        targetKeywords: ["fourteen", "cherry-red", "slate"],
        targetLabel: "Three distinct replacements",
      },
    },
  ];
}
