import { EDIT_SYSTEM_PROMPT } from "../../editing/regexEditSystemPrompt";
import { evaluateEditRegions } from "./editScoring";
import { evaluateStateAwareness } from "./evaluator";
import type { BenchmarkTestCase } from "./types";

/**
 * Rule appended to the system prompt so the model knows how to
 * interpret [ACCEPTED] / [REJECTED] annotations on prior edits.
 */
export const ANNOTATION_RULE =
  "\n- When reviewing previous edits in this conversation, blocks marked [ACCEPTED] were applied to the document, while [REJECTED] blocks were not. The current document content reflects all accepted changes.";

// =============================================================================
// Fixture paragraphs, SHORT document (3 paragraphs)
//
// Documents are composed from these constants, so the region specs handed to
// the evaluator are exact substrings of the document by construction.
// =============================================================================

/** P1 as originally written, appears only in the SEARCH side of the round-1 edit. */
const SHORT_P1_ORIGINAL = `The morning sun cast long shadows across the village square. A baker emerged from the stone building on the corner, carrying a tray of fresh bread. The aroma drifted lazily through the narrow streets.`;

/** P1 after the accepted rewrite, present in every short-doc fixture. */
export const SHORT_P1_ACCEPTED = `Dawn broke golden over the village square, stretching long shadows between the cobblestones. A baker stepped out from the stone building on the corner, balancing a tray of fresh bread on one arm. The warm aroma wound through the narrow streets like a whispered invitation.`;

/** P2 as originally written, still in the document when its rewrite was rejected. */
export const SHORT_P2_ORIGINAL = `Children gathered near the fountain, tossing pebbles into the water. An old woman sat on a wooden bench, watching them with quiet amusement. Her cat dozed in a patch of warm light beside her.`;

/** P2 after the rewrite, in the document only when that edit was accepted. */
export const SHORT_P2_REWRITE = `A handful of children crowded around the old stone fountain, skipping pebbles across its surface. An elderly woman watched from a nearby bench, a faint smile playing on her lips. Her tabby cat lay curled in a patch of sunlight beside her.`;

/** P3, never edited in any scenario. */
export const SHORT_P3_MARKET = `The church bell rang twice, marking the hour. Merchants began setting up their stalls along the eastern wall, unfurling colorful fabrics and arranging jars of preserved fruit. It was market day, and the square would soon be alive with voices.`;

const SHORT_DOC_PARTIAL = [SHORT_P1_ACCEPTED, SHORT_P2_ORIGINAL, SHORT_P3_MARKET].join("\n\n");
const SHORT_DOC_ALL_ACCEPTED = [SHORT_P1_ACCEPTED, SHORT_P2_REWRITE, SHORT_P3_MARKET].join("\n\n");

// =============================================================================
// Fixture paragraphs, LONG document (heading + 8 paragraphs)
// =============================================================================

const LONG_HEADING = `# Chapter 3: The Cartographer's Apprentice`;

const LONG_P1_WORKSHOP = `The workshop occupied the entire top floor of a narrow building wedged between a tannery and a printmaker's shop on Bellweather Lane. Elara climbed the creaking stairs each morning before dawn, when the city below still slept beneath a blanket of river fog. She liked arriving before Master Theron, it gave her time to study the half-finished maps pinned to the walls, tracing coastlines with her fingertip, memorizing the shapes of countries she had never visited.`;

const LONG_P2_ORIGINAL = `Master Theron was a meticulous man, small and wiry, with ink stains that never quite washed from his knuckles. He spoke rarely and always in clipped, measured sentences, as though words were precious commodities that should not be wasted. When he did offer instruction, Elara listened with her whole body, afraid that blinking might cause her to miss something essential.`;

/** P2 rewrite, accepted in round 1. */
export const LONG_P2_REWRITE = `Master Theron was a precise, wiry man whose ink-stained knuckles told the story of decades at the drafting table. He rationed his words the way a miser rationed coin, each one deliberate, considered, stripped of excess. When he did speak, Elara held herself still, afraid that even blinking might cost her something irreplaceable.`;

const LONG_P3_COMMISSION = `The current commission was their most ambitious: a full atlas for the Duke of Marrenthia, thirty-two sheets covering the known world from the Ash Straits in the south to the Frozen Reach in the north. Each sheet required weeks of careful drafting, coastlines first, then rivers, then elevation hatching, then borders, then names in three sizes of script. Elara was responsible for the lettering, a task that demanded a steady hand and an unforgiving eye for spacing.`;

/** P4 as originally written, its rewrite was rejected, so this text stays in the document. */
export const LONG_P4_ORIGINAL = `By midmorning the workshop filled with the smell of fresh ink and the quiet scratching of steel nibs on vellum. Theron worked at the large drafting table by the window, where the north light fell cleanly across his work. Elara sat at the smaller table near the shelves, surrounded by reference volumes and sheets of practice lettering that she would later burn in the fireplace to keep the workshop tidy.`;

/** P4 rewrite, proposed in round 1 and REJECTED; appears only inside the annotated edit block. */
const LONG_P4_REWRITE_REJECTED = `By mid-morning the air grew thick with the mineral scent of fresh ink and the rhythmic scratching of steel on vellum. Theron claimed the large table by the north-facing window, where the light was cool and even. Elara worked at the smaller station near the bookshelves, hemmed in by reference atlases and sheets of practice script destined for the fireplace.`;

const LONG_P5_ORIGINAL = `They rarely spoke during work hours. The silence was not uncomfortable, it was the silence of two people engaged in the same exacting labor, each trusting the other to maintain the standard without supervision. Occasionally Theron would hold up a sheet for Elara to inspect, and she would nod or point to a hairline wobble that needed correction. He never argued with her observations.`;

/** P5 rewrite, accepted in round 1. */
export const LONG_P5_REWRITE = `The silence between them was a living thing, not empty, but dense with shared purpose. It was the quiet of two craftspeople who had learned to read each other's rhythms: the pause before a difficult line, the soft exhale after a passage came out clean. When Theron held up a sheet, Elara's eye found the flaw before he could ask. He never once questioned her judgment.`;

const LONG_P6_LUNCH = `Lunch was bread, cheese, and whatever fruit the season offered, eaten standing at the window overlooking the lane. Theron would sometimes point out details in the street below, the way a shadow fell across a doorway, the angle of a roofline against the sky, and explain how such observations improved one's ability to render terrain. "A cartographer who cannot see," he said once, "draws maps that no one can read."`;

const LONG_P7_ORIGINAL = `In the afternoons Elara ground pigments and mixed inks according to Theron's precise formulas: lampblack and gum arabic for the main script, iron gall for borders, vermilion for capitals and compass roses. The formulas were written in a leather-bound notebook that Theron kept locked in his desk, though Elara had long since memorized them. She enjoyed the ritual of preparation, the measured weighing, the slow grinding, the moment when the ink reached exactly the right consistency and sheen.`;

/** P7 rewrite, accepted in round 2. */
export const LONG_P7_REWRITE = `Each afternoon began with the ritual of ink-making. Elara measured lampblack on the brass scale, ground it smooth in the marble mortar, then folded it into warmed gum arabic until the mixture turned glossy. Iron gall went into a separate pot for borders; vermilion, expensive and slow to prepare, was reserved for capitals and the compass roses that crowned each sheet. She no longer needed Theron's locked notebook. The formulas lived in her hands.`;

/** P8, never edited in any scenario; the long-conversation test asks for it. */
export const LONG_P8_ATLAS = `The atlas was due by midsummer. They had completed eighteen sheets and begun the nineteenth, which covered the contested borderlands between Marrenthia and its eastern neighbor. This sheet was politically sensitive, and Theron had warned Elara that the Duke's secretary would inspect it personally before it joined the collection. Every line had to be defensible, every name spelled according to Marrenthian convention, every border drawn to match the treaty of Ashford exactly.`;

/** Long doc after round 1: P2 and P5 rewrites accepted, P4 rewrite rejected. */
const LONG_DOC_AFTER_MIXED = [
  LONG_HEADING,
  LONG_P1_WORKSHOP,
  LONG_P2_REWRITE,
  LONG_P3_COMMISSION,
  LONG_P4_ORIGINAL,
  LONG_P5_REWRITE,
  LONG_P6_LUNCH,
  LONG_P7_ORIGINAL,
  LONG_P8_ATLAS,
].join("\n\n");

/** Long doc after round 2: P7 rewrite also accepted. */
const LONG_DOC_AFTER_ROUND2 = [
  LONG_HEADING,
  LONG_P1_WORKSHOP,
  LONG_P2_REWRITE,
  LONG_P3_COMMISSION,
  LONG_P4_ORIGINAL,
  LONG_P5_REWRITE,
  LONG_P6_LUNCH,
  LONG_P7_REWRITE,
  LONG_P8_ATLAS,
].join("\n\n");

// =============================================================================
// Synthetic assistant turns (prior edit rounds, with outcome annotations)
// =============================================================================

function editBlock(searchText: string, replaceText: string): string {
  return `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`;
}

const ACCEPTED_NOTE = "\n[ACCEPTED, applied to document]";
const REJECTED_NOTE = "\n[REJECTED, not applied]";

const SHORT_BLOCK_1 = editBlock(SHORT_P1_ORIGINAL, SHORT_P1_ACCEPTED);
const SHORT_BLOCK_2 = editBlock(SHORT_P2_ORIGINAL, SHORT_P2_REWRITE);

const SHORT_PROSE = "I've rewritten two paragraphs to add more vivid imagery and sensory detail:\n\n";

const SHORT_EDIT_RAW = SHORT_PROSE + SHORT_BLOCK_1 + "\n\n" + SHORT_BLOCK_2;

const SHORT_EDIT_ANNOTATED =
  SHORT_PROSE +
  SHORT_BLOCK_1 + ACCEPTED_NOTE +
  "\n\n" +
  SHORT_BLOCK_2 + REJECTED_NOTE +
  "\n\n[Edit outcome: 1 accepted, 1 rejected out of 2 proposed changes]";

const SHORT_EDIT_ALL_ACCEPTED =
  SHORT_PROSE +
  SHORT_BLOCK_1 + ACCEPTED_NOTE +
  "\n\n" +
  SHORT_BLOCK_2 + ACCEPTED_NOTE +
  "\n\n[Edit outcome: 2 accepted, 0 rejected out of 2 proposed changes]";

const LONG_R1_PROSE = "I've reworked three paragraphs to sharpen the characterization and deepen the atmosphere:\n\n";

const LONG_R1_ANNOTATED =
  LONG_R1_PROSE +
  editBlock(LONG_P2_ORIGINAL, LONG_P2_REWRITE) + ACCEPTED_NOTE +
  "\n\n" +
  editBlock(LONG_P4_ORIGINAL, LONG_P4_REWRITE_REJECTED) + REJECTED_NOTE +
  "\n\n" +
  editBlock(LONG_P5_ORIGINAL, LONG_P5_REWRITE) + ACCEPTED_NOTE +
  "\n\n[Edit outcome: 2 accepted, 1 rejected out of 3 proposed changes]";

const LONG_R2_PROSE = "Here's a reworked version of the ink-preparation paragraph with more sensory detail:\n\n";

const LONG_R2_ANNOTATED =
  LONG_R2_PROSE +
  editBlock(LONG_P7_ORIGINAL, LONG_P7_REWRITE) + ACCEPTED_NOTE +
  "\n\n[Edit outcome: 1 accepted, 0 rejected out of 1 proposed changes]";

// =============================================================================
// Test cases
// =============================================================================

export function getTestCases(): BenchmarkTestCase[] {
  return [
    // ----- Short doc, basic scenarios -----
    {
      id: "respect-rejected",
      name: "Respect rejected edits",
      description:
        "Short document, 2 edits proposed (1 accepted, 1 rejected). " +
        "Model should rework the rejected fountain paragraph, not the accepted opening.",
      document: SHORT_DOC_PARTIAL,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you make the opening paragraph and the fountain scene more vivid?" },
        { role: "assistant", content: SHORT_EDIT_ANNOTATED },
        { role: "user", content: "I liked the first change but not the second. Can you try rewriting the fountain paragraph again with a different approach?" },
      ],
      evaluate: evaluateEditRegions,
      regions: {
        target: { label: "rejected fountain paragraph", text: SHORT_P2_ORIGINAL },
        forbidden: [{ label: "accepted opening paragraph", text: SHORT_P1_ACCEPTED }],
      },
      criteria: {
        expectedOutcome:
          "Model produces SEARCH/REPLACE blocks that match the document text exactly, rewrite the rejected fountain paragraph, and leave the accepted opening untouched.",
        targetLabel: "Rejected fountain paragraph",
        targetKeywords: ["children", "fountain", "pebbles", "old woman", "bench"],
        forbiddenLabel: "Accepted opening paragraph",
        forbiddenKeywords: ["dawn broke golden", "cobblestones", "whispered invitation"],
        notes: "Blocks are resolved against the document with the real diff engine; a block that would not apply fails the test.",
      },
    },
    {
      id: "no-repropose-accepted",
      name: "Don't re-propose accepted edits",
      description:
        "Short document, all edits accepted. Model should target the untouched market-day paragraph, not re-propose accepted content.",
      document: SHORT_DOC_ALL_ACCEPTED,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you make the opening paragraph and the fountain scene more vivid?" },
        { role: "assistant", content: SHORT_EDIT_ALL_ACCEPTED },
        { role: "user", content: "Great, those look good. Can you also improve the final paragraph about market day?" },
      ],
      evaluate: evaluateEditRegions,
      regions: {
        target: { label: "market-day paragraph", text: SHORT_P3_MARKET },
        forbidden: [
          { label: "accepted opening paragraph", text: SHORT_P1_ACCEPTED },
          { label: "accepted fountain rewrite", text: SHORT_P2_REWRITE },
        ],
      },
      criteria: {
        expectedOutcome:
          "Model produces SEARCH/REPLACE blocks targeting the market-day paragraph without re-proposing already-accepted content.",
        targetLabel: "Untouched market-day paragraph",
        targetKeywords: ["church bell", "merchants", "market day", "stalls", "eastern wall"],
        forbiddenLabel: "Accepted content",
        forbiddenKeywords: ["dawn broke golden", "old stone fountain"],
      },
    },
    {
      id: "state-awareness",
      name: "Awareness of current document state",
      description:
        "Short document, partial accept. Model should distinguish accepted vs rejected edits when describing the document's current state.",
      document: SHORT_DOC_PARTIAL,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you make the opening paragraph and the fountain scene more vivid?" },
        { role: "assistant", content: SHORT_EDIT_ANNOTATED },
        { role: "user", content: "Before we continue, can you briefly summarize the current state of the document, which of your changes are reflected and which are not?" },
      ],
      evaluate: evaluateStateAwareness,
      criteria: {
        expectedOutcome: "Model's prose response distinguishes between accepted (applied) and rejected (not applied) edits.",
        requiredMentions: ["accepted/applied", "rejected/unchanged"],
        notes:
          "Evaluates prose output, not edit blocks. The response must pair the opening change with accepted language and the fountain change with rejected language in the same sentence.",
      },
    },

    // ----- Long doc scenarios -----
    {
      id: "long-doc-precision",
      name: "Long document, edit precision",
      description:
        "8-paragraph document, 3 edits proposed (2 accepted, 1 rejected). " +
        "Model should rework the rejected midmorning paragraph without touching the accepted or untouched paragraphs.",
      document: LONG_DOC_AFTER_MIXED,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you strengthen the character descriptions and the working-silence paragraph? Also see if the midmorning paragraph can be more atmospheric." },
        { role: "assistant", content: LONG_R1_ANNOTATED },
        { role: "user", content: "The first and third changes are great. The midmorning paragraph rewrite didn't feel right, can you try a different take on it?" },
      ],
      evaluate: evaluateEditRegions,
      regions: {
        target: { label: "rejected midmorning paragraph (P4)", text: LONG_P4_ORIGINAL },
        forbidden: [
          { label: "accepted Theron paragraph (P2)", text: LONG_P2_REWRITE },
          { label: "accepted silence paragraph (P5)", text: LONG_P5_REWRITE },
          { label: "untouched atlas paragraph (P8)", text: LONG_P8_ATLAS },
        ],
      },
      criteria: {
        expectedOutcome:
          "Model produces SEARCH/REPLACE blocks targeting only the rejected midmorning paragraph (P4) without touching accepted or untouched paragraphs.",
        targetLabel: "Rejected midmorning paragraph (P4)",
        targetKeywords: ["midmorning", "steel nibs on vellum", "practice lettering"],
        forbiddenLabel: "Accepted P2 + P5, untouched atlas (P8)",
        forbiddenKeywords: ["rationed his words", "living thing", "contested borderlands"],
      },
    },
    {
      id: "multi-round-continuity",
      name: "Multi-round edit continuity",
      description:
        "Long document after 2 rounds of edits (round 1: 2 accepted + 1 rejected, round 2: 1 accepted). " +
        "Model should target the still-rejected paragraph 4, not revisit any accepted changes.",
      document: LONG_DOC_AFTER_ROUND2,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you strengthen the character descriptions and the working-silence paragraph? Also see if the midmorning paragraph can be more atmospheric." },
        { role: "assistant", content: LONG_R1_ANNOTATED },
        { role: "user", content: "The first and third changes are great. Let's skip the midmorning one for now. Can you also rework the ink-preparation paragraph?" },
        { role: "assistant", content: LONG_R2_ANNOTATED },
        { role: "user", content: "Perfect. Now let's revisit that midmorning paragraph, the original version is still there. Can you try improving it?" },
      ],
      evaluate: evaluateEditRegions,
      regions: {
        target: { label: "still-rejected midmorning paragraph (P4)", text: LONG_P4_ORIGINAL },
        forbidden: [
          { label: "accepted Theron paragraph (P2)", text: LONG_P2_REWRITE },
          { label: "accepted silence paragraph (P5)", text: LONG_P5_REWRITE },
          { label: "accepted ink paragraph (P7)", text: LONG_P7_REWRITE },
        ],
      },
      criteria: {
        expectedOutcome:
          "Model produces SEARCH/REPLACE blocks targeting the still-rejected midmorning paragraph (P4) without revisiting any accepted edits from either round.",
        targetLabel: "Still-rejected midmorning paragraph (P4)",
        targetKeywords: ["midmorning", "steel nibs on vellum", "practice lettering"],
        forbiddenLabel: "Accepted P2 (round 1) + accepted ink paragraph (round 2)",
        forbiddenKeywords: ["rationed his words", "brass scale", "marble mortar"],
      },
    },
    {
      id: "long-conversation-context",
      name: "Long conversation, context retention",
      description:
        "Long document with extended back-and-forth conversation (2 edit rounds + discussion). " +
        "Tests whether the model retains context about what's been changed across many messages.",
      document: LONG_DOC_AFTER_ROUND2,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you strengthen the character descriptions and the working-silence paragraph? Also see if the midmorning paragraph can be more atmospheric." },
        { role: "assistant", content: LONG_R1_ANNOTATED },
        { role: "user", content: "The first and third changes are great. Let's skip the midmorning one for now. Can you also rework the ink-preparation paragraph?" },
        { role: "assistant", content: LONG_R2_ANNOTATED },
        { role: "user", content: "Nice work on the inks paragraph. Quick question, how many paragraphs have we changed so far, and which ones are still in their original form?" },
        { role: "assistant", content: "We've changed three paragraphs so far:\n\n1. **Paragraph 2** (Master Theron's description), accepted in round 1\n2. **Paragraph 5** (the working silence), accepted in round 1\n3. **Paragraph 7** (ink preparation), accepted in round 2\n\nThe midmorning workshop paragraph (paragraph 4) was proposed but rejected, so it remains in its original form. Paragraphs 1, 3, 6, and 8 have not been touched." },
        { role: "user", content: "Great summary. Now can you improve the final paragraph about the atlas deadline? Make it feel more tense and high-stakes." },
      ],
      evaluate: evaluateEditRegions,
      regions: {
        target: { label: "atlas deadline paragraph (P8)", text: LONG_P8_ATLAS },
        forbidden: [
          { label: "accepted Theron paragraph (P2)", text: LONG_P2_REWRITE },
          { label: "accepted silence paragraph (P5)", text: LONG_P5_REWRITE },
          { label: "accepted ink paragraph (P7)", text: LONG_P7_REWRITE },
        ],
      },
      criteria: {
        expectedOutcome:
          "Model produces SEARCH/REPLACE blocks targeting the atlas/deadline paragraph (P8) without revisiting previously accepted edits.",
        targetLabel: "Atlas/deadline paragraph (P8)",
        targetKeywords: ["contested borderlands", "duke's secretary", "treaty of ashford"],
        forbiddenLabel: "Accepted P2 (round 1) + accepted ink paragraph (round 2)",
        forbiddenKeywords: ["rationed his words", "brass scale", "marble mortar"],
      },
    },

    // ----- Control -----
    {
      id: "control-no-annotations",
      name: "Control, without annotations",
      description:
        "Same as 'Respect rejected edits' but without outcome annotations. The model must infer from the user's message alone. Expected to be less reliable.",
      document: SHORT_DOC_PARTIAL,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: "Can you make the opening paragraph and the fountain scene more vivid?" },
        { role: "assistant", content: SHORT_EDIT_RAW },
        { role: "user", content: "I liked the first change but not the second. Can you try rewriting the fountain paragraph again with a different approach?" },
      ],
      evaluate: evaluateEditRegions,
      regions: {
        target: { label: "rejected fountain paragraph", text: SHORT_P2_ORIGINAL },
        forbidden: [{ label: "accepted opening paragraph", text: SHORT_P1_ACCEPTED }],
      },
      criteria: {
        expectedOutcome: "Model infers the rejected edit from the user message alone and targets the fountain paragraph.",
        targetLabel: "Rejected fountain paragraph",
        targetKeywords: ["children", "fountain", "pebbles", "old woman"],
        forbiddenLabel: "Accepted opening paragraph",
        forbiddenKeywords: ["dawn broke golden", "cobblestones"],
        notes: "No [ACCEPTED]/[REJECTED] annotations present. Model must infer from user feedback alone. Expected to be less reliable.",
      },
      isControl: true,
    },
  ];
}
