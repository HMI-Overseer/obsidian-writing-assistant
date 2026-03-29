import { EDIT_SYSTEM_PROMPT } from "../../editing/editSystemPrompt";
import {
  evaluateRejectedRework,
  evaluateNoRepropose,
  evaluateStateAwareness,
  evaluateControlNoAnnotations,
  evaluateLongDocPrecision,
  evaluateMultiRoundContinuity,
  evaluateConversationContext,
} from "./evaluator";
import type { BenchmarkTestCase } from "./types";

/**
 * Rule appended to the system prompt so the model knows how to
 * interpret [ACCEPTED] / [REJECTED] annotations on prior edits.
 */
export const ANNOTATION_RULE =
  "\n- When reviewing previous edits in this conversation, blocks marked [ACCEPTED] were applied to the document, while [REJECTED] blocks were not. The current document content reflects all accepted changes.";

// =========================================================================
// Fixture: SHORT document (3 paragraphs) — original tests
// =========================================================================

const SHORT_DOC_PARTIAL = `Dawn broke golden over the village square, stretching long shadows between the cobblestones. A baker stepped out from the stone building on the corner, balancing a tray of fresh bread on one arm. The warm aroma wound through the narrow streets like a whispered invitation.

Children gathered near the fountain, tossing pebbles into the water. An old woman sat on a wooden bench, watching them with quiet amusement. Her cat dozed in a patch of warm light beside her.

The church bell rang twice, marking the hour. Merchants began setting up their stalls along the eastern wall, unfurling colorful fabrics and arranging jars of preserved fruit. It was market day, and the square would soon be alive with voices.`;

const SHORT_DOC_ALL_ACCEPTED = `Dawn broke golden over the village square, stretching long shadows between the cobblestones. A baker stepped out from the stone building on the corner, balancing a tray of fresh bread on one arm. The warm aroma wound through the narrow streets like a whispered invitation.

A handful of children crowded around the old stone fountain, skipping pebbles across its surface. An elderly woman watched from a nearby bench, a faint smile playing on her lips. Her tabby cat lay curled in a patch of sunlight beside her.

The church bell rang twice, marking the hour. Merchants began setting up their stalls along the eastern wall, unfurling colorful fabrics and arranging jars of preserved fruit. It was market day, and the square would soon be alive with voices.`;

// =========================================================================
// Fixture: LONG document (8 paragraphs) — stresses context window
// =========================================================================

/** Full original document before any edits. Referenced by SEARCH blocks. */
export const LONG_DOC_ORIGINAL = `# Chapter 3: The Cartographer's Apprentice

The workshop occupied the entire top floor of a narrow building wedged between a tannery and a printmaker's shop on Bellweather Lane. Elara climbed the creaking stairs each morning before dawn, when the city below still slept beneath a blanket of river fog. She liked arriving before Master Theron — it gave her time to study the half-finished maps pinned to the walls, tracing coastlines with her fingertip, memorizing the shapes of countries she had never visited.

Master Theron was a meticulous man, small and wiry, with ink stains that never quite washed from his knuckles. He spoke rarely and always in clipped, measured sentences, as though words were precious commodities that should not be wasted. When he did offer instruction, Elara listened with her whole body, afraid that blinking might cause her to miss something essential.

The current commission was their most ambitious: a full atlas for the Duke of Marrenthia, thirty-two sheets covering the known world from the Ash Straits in the south to the Frozen Reach in the north. Each sheet required weeks of careful drafting — coastlines first, then rivers, then elevation hatching, then borders, then names in three sizes of script. Elara was responsible for the lettering, a task that demanded a steady hand and an unforgiving eye for spacing.

By midmorning the workshop filled with the smell of fresh ink and the quiet scratching of steel nibs on vellum. Theron worked at the large drafting table by the window, where the north light fell cleanly across his work. Elara sat at the smaller table near the shelves, surrounded by reference volumes and sheets of practice lettering that she would later burn in the fireplace to keep the workshop tidy.

They rarely spoke during work hours. The silence was not uncomfortable — it was the silence of two people engaged in the same exacting labor, each trusting the other to maintain the standard without supervision. Occasionally Theron would hold up a sheet for Elara to inspect, and she would nod or point to a hairline wobble that needed correction. He never argued with her observations.

Lunch was bread, cheese, and whatever fruit the season offered, eaten standing at the window overlooking the lane. Theron would sometimes point out details in the street below — the way a shadow fell across a doorway, the angle of a roofline against the sky — and explain how such observations improved one's ability to render terrain. "A cartographer who cannot see," he said once, "draws maps that no one can read."

In the afternoons Elara ground pigments and mixed inks according to Theron's precise formulas: lampblack and gum arabic for the main script, iron gall for borders, vermilion for capitals and compass roses. The formulas were written in a leather-bound notebook that Theron kept locked in his desk, though Elara had long since memorized them. She enjoyed the ritual of preparation — the measured weighing, the slow grinding, the moment when the ink reached exactly the right consistency and sheen.

The atlas was due by midsummer. They had completed eighteen sheets and begun the nineteenth, which covered the contested borderlands between Marrenthia and its eastern neighbor. This sheet was politically sensitive, and Theron had warned Elara that the Duke's secretary would inspect it personally before it joined the collection. Every line had to be defensible, every name spelled according to Marrenthian convention, every border drawn to match the treaty of Ashford exactly.`;

/** Long doc after edits to paragraphs 2 and 5 accepted, paragraph 4 rejected. */
const LONG_DOC_AFTER_MIXED = `# Chapter 3: The Cartographer's Apprentice

The workshop occupied the entire top floor of a narrow building wedged between a tannery and a printmaker's shop on Bellweather Lane. Elara climbed the creaking stairs each morning before dawn, when the city below still slept beneath a blanket of river fog. She liked arriving before Master Theron — it gave her time to study the half-finished maps pinned to the walls, tracing coastlines with her fingertip, memorizing the shapes of countries she had never visited.

Master Theron was a precise, wiry man whose ink-stained knuckles told the story of decades at the drafting table. He rationed his words the way a miser rationed coin — each one deliberate, considered, stripped of excess. When he did speak, Elara held herself still, afraid that even blinking might cost her something irreplaceable.

The current commission was their most ambitious: a full atlas for the Duke of Marrenthia, thirty-two sheets covering the known world from the Ash Straits in the south to the Frozen Reach in the north. Each sheet required weeks of careful drafting — coastlines first, then rivers, then elevation hatching, then borders, then names in three sizes of script. Elara was responsible for the lettering, a task that demanded a steady hand and an unforgiving eye for spacing.

By midmorning the workshop filled with the smell of fresh ink and the quiet scratching of steel nibs on vellum. Theron worked at the large drafting table by the window, where the north light fell cleanly across his work. Elara sat at the smaller table near the shelves, surrounded by reference volumes and sheets of practice lettering that she would later burn in the fireplace to keep the workshop tidy.

The silence between them was a living thing — not empty, but dense with shared purpose. It was the quiet of two craftspeople who had learned to read each other's rhythms: the pause before a difficult line, the soft exhale after a passage came out clean. When Theron held up a sheet, Elara's eye found the flaw before he could ask. He never once questioned her judgment.

Lunch was bread, cheese, and whatever fruit the season offered, eaten standing at the window overlooking the lane. Theron would sometimes point out details in the street below — the way a shadow fell across a doorway, the angle of a roofline against the sky — and explain how such observations improved one's ability to render terrain. "A cartographer who cannot see," he said once, "draws maps that no one can read."

In the afternoons Elara ground pigments and mixed inks according to Theron's precise formulas: lampblack and gum arabic for the main script, iron gall for borders, vermilion for capitals and compass roses. The formulas were written in a leather-bound notebook that Theron kept locked in his desk, though Elara had long since memorized them. She enjoyed the ritual of preparation — the measured weighing, the slow grinding, the moment when the ink reached exactly the right consistency and sheen.

The atlas was due by midsummer. They had completed eighteen sheets and begun the nineteenth, which covered the contested borderlands between Marrenthia and its eastern neighbor. This sheet was politically sensitive, and Theron had warned Elara that the Duke's secretary would inspect it personally before it joined the collection. Every line had to be defensible, every name spelled according to Marrenthian convention, every border drawn to match the treaty of Ashford exactly.`;

// =========================================================================
// Fixture: LONG document after two rounds of edits
// =========================================================================

/** After round 2: paragraph 7 (inks) was also rewritten and accepted. */
const LONG_DOC_AFTER_ROUND2 = `# Chapter 3: The Cartographer's Apprentice

The workshop occupied the entire top floor of a narrow building wedged between a tannery and a printmaker's shop on Bellweather Lane. Elara climbed the creaking stairs each morning before dawn, when the city below still slept beneath a blanket of river fog. She liked arriving before Master Theron — it gave her time to study the half-finished maps pinned to the walls, tracing coastlines with her fingertip, memorizing the shapes of countries she had never visited.

Master Theron was a precise, wiry man whose ink-stained knuckles told the story of decades at the drafting table. He rationed his words the way a miser rationed coin — each one deliberate, considered, stripped of excess. When he did speak, Elara held herself still, afraid that even blinking might cost her something irreplaceable.

The current commission was their most ambitious: a full atlas for the Duke of Marrenthia, thirty-two sheets covering the known world from the Ash Straits in the south to the Frozen Reach in the north. Each sheet required weeks of careful drafting — coastlines first, then rivers, then elevation hatching, then borders, then names in three sizes of script. Elara was responsible for the lettering, a task that demanded a steady hand and an unforgiving eye for spacing.

By midmorning the workshop filled with the smell of fresh ink and the quiet scratching of steel nibs on vellum. Theron worked at the large drafting table by the window, where the north light fell cleanly across his work. Elara sat at the smaller table near the shelves, surrounded by reference volumes and sheets of practice lettering that she would later burn in the fireplace to keep the workshop tidy.

The silence between them was a living thing — not empty, but dense with shared purpose. It was the quiet of two craftspeople who had learned to read each other's rhythms: the pause before a difficult line, the soft exhale after a passage came out clean. When Theron held up a sheet, Elara's eye found the flaw before he could ask. He never once questioned her judgment.

Lunch was bread, cheese, and whatever fruit the season offered, eaten standing at the window overlooking the lane. Theron would sometimes point out details in the street below — the way a shadow fell across a doorway, the angle of a roofline against the sky — and explain how such observations improved one's ability to render terrain. "A cartographer who cannot see," he said once, "draws maps that no one can read."

Each afternoon began with the ritual of ink-making. Elara measured lampblack on the brass scale, ground it smooth in the marble mortar, then folded it into warmed gum arabic until the mixture turned glossy. Iron gall went into a separate pot for borders; vermilion — expensive and slow to prepare — was reserved for capitals and the compass roses that crowned each sheet. She no longer needed Theron's locked notebook. The formulas lived in her hands.

The atlas was due by midsummer. They had completed eighteen sheets and begun the nineteenth, which covered the contested borderlands between Marrenthia and its eastern neighbor. This sheet was politically sensitive, and Theron had warned Elara that the Duke's secretary would inspect it personally before it joined the collection. Every line had to be defensible, every name spelled according to Marrenthian convention, every border drawn to match the treaty of Ashford exactly.`;

// =========================================================================
// Edit blocks — short doc
// =========================================================================

const SHORT_BLOCK_1 = `<<<SEARCH
The morning sun cast long shadows across the village square. A baker emerged from the stone building on the corner, carrying a tray of fresh bread. The aroma drifted lazily through the narrow streets.
===
Dawn broke golden over the village square, stretching long shadows between the cobblestones. A baker stepped out from the stone building on the corner, balancing a tray of fresh bread on one arm. The warm aroma wound through the narrow streets like a whispered invitation.
REPLACE>>>`;

const SHORT_BLOCK_2 = `<<<SEARCH
Children gathered near the fountain, tossing pebbles into the water. An old woman sat on a wooden bench, watching them with quiet amusement. Her cat dozed in a patch of warm light beside her.
===
A handful of children crowded around the old stone fountain, skipping pebbles across its surface. An elderly woman watched from a nearby bench, a faint smile playing on her lips. Her tabby cat lay curled in a patch of sunlight beside her.
REPLACE>>>`;

const SHORT_PROSE = "I've rewritten two paragraphs to add more vivid imagery and sensory detail:\n\n";

const SHORT_EDIT_RAW = SHORT_PROSE + SHORT_BLOCK_1 + "\n\n" + SHORT_BLOCK_2;

const SHORT_EDIT_ANNOTATED =
  SHORT_PROSE +
  SHORT_BLOCK_1 + "\n[ACCEPTED — applied to document]" +
  "\n\n" +
  SHORT_BLOCK_2 + "\n[REJECTED — not applied]" +
  "\n\n[Edit outcome: 1 accepted, 1 rejected out of 2 proposed changes]";

const SHORT_EDIT_ALL_ACCEPTED =
  SHORT_PROSE +
  SHORT_BLOCK_1 + "\n[ACCEPTED — applied to document]" +
  "\n\n" +
  SHORT_BLOCK_2 + "\n[ACCEPTED — applied to document]" +
  "\n\n[Edit outcome: 2 accepted, 0 rejected out of 2 proposed changes]";

// =========================================================================
// Edit blocks — long doc, round 1 (paragraphs 2, 4, 5)
// =========================================================================

const LONG_R1_BLOCK_P2 = `<<<SEARCH
Master Theron was a meticulous man, small and wiry, with ink stains that never quite washed from his knuckles. He spoke rarely and always in clipped, measured sentences, as though words were precious commodities that should not be wasted. When he did offer instruction, Elara listened with her whole body, afraid that blinking might cause her to miss something essential.
===
Master Theron was a precise, wiry man whose ink-stained knuckles told the story of decades at the drafting table. He rationed his words the way a miser rationed coin — each one deliberate, considered, stripped of excess. When he did speak, Elara held herself still, afraid that even blinking might cost her something irreplaceable.
REPLACE>>>`;

const LONG_R1_BLOCK_P4 = `<<<SEARCH
By midmorning the workshop filled with the smell of fresh ink and the quiet scratching of steel nibs on vellum. Theron worked at the large drafting table by the window, where the north light fell cleanly across his work. Elara sat at the smaller table near the shelves, surrounded by reference volumes and sheets of practice lettering that she would later burn in the fireplace to keep the workshop tidy.
===
By mid-morning the air grew thick with the mineral scent of fresh ink and the rhythmic scratching of steel on vellum. Theron claimed the large table by the north-facing window, where the light was cool and even. Elara worked at the smaller station near the bookshelves, hemmed in by reference atlases and sheets of practice script destined for the fireplace.
REPLACE>>>`;

const LONG_R1_BLOCK_P5 = `<<<SEARCH
They rarely spoke during work hours. The silence was not uncomfortable — it was the silence of two people engaged in the same exacting labor, each trusting the other to maintain the standard without supervision. Occasionally Theron would hold up a sheet for Elara to inspect, and she would nod or point to a hairline wobble that needed correction. He never argued with her observations.
===
The silence between them was a living thing — not empty, but dense with shared purpose. It was the quiet of two craftspeople who had learned to read each other's rhythms: the pause before a difficult line, the soft exhale after a passage came out clean. When Theron held up a sheet, Elara's eye found the flaw before he could ask. He never once questioned her judgment.
REPLACE>>>`;

const LONG_R1_PROSE = "I've reworked three paragraphs to sharpen the characterization and deepen the atmosphere:\n\n";

const LONG_R1_ANNOTATED =
  LONG_R1_PROSE +
  LONG_R1_BLOCK_P2 + "\n[ACCEPTED — applied to document]" +
  "\n\n" +
  LONG_R1_BLOCK_P4 + "\n[REJECTED — not applied]" +
  "\n\n" +
  LONG_R1_BLOCK_P5 + "\n[ACCEPTED — applied to document]" +
  "\n\n[Edit outcome: 2 accepted, 1 rejected out of 3 proposed changes]";

// =========================================================================
// Edit blocks — long doc, round 2 (paragraph 7: inks)
// =========================================================================

const LONG_R2_BLOCK_P7 = `<<<SEARCH
In the afternoons Elara ground pigments and mixed inks according to Theron's precise formulas: lampblack and gum arabic for the main script, iron gall for borders, vermilion for capitals and compass roses. The formulas were written in a leather-bound notebook that Theron kept locked in his desk, though Elara had long since memorized them. She enjoyed the ritual of preparation — the measured weighing, the slow grinding, the moment when the ink reached exactly the right consistency and sheen.
===
Each afternoon began with the ritual of ink-making. Elara measured lampblack on the brass scale, ground it smooth in the marble mortar, then folded it into warmed gum arabic until the mixture turned glossy. Iron gall went into a separate pot for borders; vermilion — expensive and slow to prepare — was reserved for capitals and the compass roses that crowned each sheet. She no longer needed Theron's locked notebook. The formulas lived in her hands.
REPLACE>>>`;

const LONG_R2_PROSE = "Here's a reworked version of the ink-preparation paragraph with more sensory detail:\n\n";

const LONG_R2_ANNOTATED =
  LONG_R2_PROSE +
  LONG_R2_BLOCK_P7 + "\n[ACCEPTED — applied to document]" +
  "\n\n[Edit outcome: 1 accepted, 0 rejected out of 1 proposed changes]";

// =========================================================================
// Exported constants for evaluators
// =========================================================================

/** Short doc: the rejected hunk's original text — still in the document. */
export const REJECTED_REGION_TEXT =
  "Children gathered near the fountain, tossing pebbles into the water.";

/** Short doc: the accepted hunk's replacement text — already in the document. */
export const ACCEPTED_REPLACEMENT_TEXT =
  "Dawn broke golden over the village square";

/** Short doc: phrase from the post-edit state. */
export const POST_EDIT_MARKER = "stretching long shadows between the cobblestones";

/** Long doc: keywords from the REJECTED paragraph 4 (still original in document). */
export const LONG_REJECTED_KEYWORDS = [
  "midmorning",
  "steel nibs on vellum",
  "practice lettering",
  "burn in the fireplace",
];

/** Long doc: keywords from ACCEPTED paragraph 2 replacement. */
export const LONG_ACCEPTED_P2_KEYWORDS = [
  "rationed his words",
  "miser rationed coin",
];

/** Long doc: keywords from the ink paragraph (round 2 accepted). */
export const LONG_R2_INK_KEYWORDS = [
  "brass scale",
  "marble mortar",
  "formulas lived in her hands",
];

/** Long doc: keywords from the atlas/borderlands paragraph (untouched). */
export const LONG_ATLAS_KEYWORDS = [
  "contested borderlands",
  "duke's secretary",
  "treaty of ashford",
];

// =========================================================================
// Test cases
// =========================================================================

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
      evaluate: evaluateRejectedRework,
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
      evaluate: evaluateNoRepropose,
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
        { role: "user", content: "Before we continue, can you briefly summarize the current state of the document — which of your changes are reflected and which are not?" },
      ],
      evaluate: evaluateStateAwareness,
    },

    // ----- Long doc scenarios -----
    {
      id: "long-doc-precision",
      name: "Long document — edit precision",
      description:
        "8-paragraph document, 3 edits proposed (2 accepted, 1 rejected). " +
        "Model should rework the rejected midmorning paragraph without touching the 5 untouched paragraphs.",
      document: LONG_DOC_AFTER_MIXED,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you strengthen the character descriptions and the working-silence paragraph? Also see if the midmorning paragraph can be more atmospheric." },
        { role: "assistant", content: LONG_R1_ANNOTATED },
        { role: "user", content: "The first and third changes are great. The midmorning paragraph rewrite didn't feel right — can you try a different take on it?" },
      ],
      evaluate: evaluateLongDocPrecision,
    },
    {
      id: "multi-round-continuity",
      name: "Multi-round edit continuity",
      description:
        "Long document after 2 rounds of edits (round 1: 2 accepted + 1 rejected, round 2: 1 accepted). " +
        "Model should target the still-rejected paragraph 4 or untouched paragraphs, not revisit any accepted changes.",
      document: LONG_DOC_AFTER_ROUND2,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT + ANNOTATION_RULE,
      messages: [
        { role: "user", content: "Can you strengthen the character descriptions and the working-silence paragraph? Also see if the midmorning paragraph can be more atmospheric." },
        { role: "assistant", content: LONG_R1_ANNOTATED },
        { role: "user", content: "The first and third changes are great. Let's skip the midmorning one for now. Can you also rework the ink-preparation paragraph?" },
        { role: "assistant", content: LONG_R2_ANNOTATED },
        { role: "user", content: "Perfect. Now let's revisit that midmorning paragraph — the original version is still there. Can you try improving it?" },
      ],
      evaluate: evaluateMultiRoundContinuity,
    },
    {
      id: "long-conversation-context",
      name: "Long conversation — context retention",
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
        { role: "user", content: "Nice work on the inks paragraph. Quick question — how many paragraphs have we changed so far, and which ones are still in their original form?" },
        { role: "assistant", content: "We've changed three paragraphs so far:\n\n1. **Paragraph 2** (Master Theron's description) — accepted in round 1\n2. **Paragraph 5** (the working silence) — accepted in round 1\n3. **Paragraph 7** (ink preparation) — accepted in round 2\n\nThe midmorning workshop paragraph (paragraph 4) was proposed but rejected, so it remains in its original form. Paragraphs 1, 3, 6, and 8 have not been touched." },
        { role: "user", content: "Great summary. Now can you improve the final paragraph about the atlas deadline? Make it feel more tense and high-stakes." },
      ],
      evaluate: evaluateConversationContext,
    },

    // ----- Control -----
    {
      id: "control-no-annotations",
      name: "Control — without annotations",
      description:
        "Same as 'Respect rejected edits' but without outcome annotations. The model must infer from the user's message alone. Expected to be less reliable.",
      document: SHORT_DOC_PARTIAL,
      systemPromptSuffix: EDIT_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: "Can you make the opening paragraph and the fountain scene more vivid?" },
        { role: "assistant", content: SHORT_EDIT_RAW },
        { role: "user", content: "I liked the first change but not the second. Can you try rewriting the fountain paragraph again with a different approach?" },
      ],
      evaluate: evaluateControlNoAnnotations,
      isControl: true,
    },
  ];
}
