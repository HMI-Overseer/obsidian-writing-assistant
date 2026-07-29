import {
  assistantProse,
  composerFooter,
  messagesPane,
  userMessage,
} from "./chat.mjs";
import { I } from "./icons.mjs";

export const askOption = (
  id,
  name,
  label,
  description,
  { checked = false, focused = false, multi = false } = {},
) =>
  `<div class="lmsa-interaction-option">
    <input class="lmsa-interaction-option-input" type="${multi ? "checkbox" : "radio"}"
      id="${id}" name="${name}" aria-describedby="${id}-description"${checked ? " checked" : ""}${focused ? " autofocus" : ""}>
    <label class="lmsa-interaction-option-label" for="${id}">
      <span class="lmsa-interaction-option-name">${label}</span>
      <span class="lmsa-interaction-option-description" id="${id}-description">${description}</span>
    </label>
  </div>`;

export const askOther = (
  id,
  name,
  { checked = false, multi = false, text = "" } = {},
) =>
  `<div class="lmsa-interaction-option lmsa-interaction-other-option${checked ? " is-other-expanded" : ""}">
    <input class="lmsa-interaction-option-input" type="${multi ? "checkbox" : "radio"}"
      id="${id}" name="${name}"${checked ? " checked" : ""}>
    <label class="lmsa-interaction-option-label" for="${id}">
      <span class="lmsa-interaction-option-name">Other</span>
    </label>
    <div class="lmsa-interaction-other-text"${checked ? "" : " hidden"}>
      <textarea class="lmsa-interaction-other-textarea" id="${id}-text" aria-label="Other answer" rows="3"
        maxlength="500" placeholder="Type your answer">${text}</textarea>
    </div>
  </div>`;

export const askQuestion = ({
  id,
  index,
  total,
  header,
  question,
  multi = false,
  options,
  other,
  complete = false,
  incomplete = false,
}) => ({
  id,
  index,
  total,
  header,
  complete,
  html: (active) =>
    `<div class="lmsa-ask-form-question-panel" id="${id}-panel" role="tabpanel"
      aria-labelledby="${id}-tab"${active ? "" : " hidden"}>
      <fieldset class="lmsa-ask-form-question${complete ? " is-complete" : ""}${incomplete ? " is-incomplete" : ""}">
        <legend class="lmsa-ask-form-legend">
          <span class="lmsa-ask-form-question-meta">
            <span class="lmsa-ask-form-question-number">Question ${index} of ${total}</span>
          </span>
          <span class="lmsa-ask-form-question-text">${question}</span>
        </legend>
        <div class="lmsa-interaction-options">
          ${options.map((option, optionIndex) => askOption(
            `${id}-o${optionIndex}`,
            id,
            option.label,
            option.description,
            { checked: option.checked, focused: option.focused, multi },
          )).join("")}
          ${askOther(`${id}-other`, id, { ...other, multi })}
        </div>
      </fieldset>
    </div>`,
});

export const askForm = (
  questions,
  {
    ready = false,
    showError = false,
    activeIndex = 0,
    collapsed = false,
  } = {},
) => {
  const tabs = questions.map((question, questionIndex) => {
    const active = questionIndex === activeIndex;
    return `<button class="lmsa-ask-form-tab${active ? " is-active" : ""}${question.complete ? " is-complete" : ""}"
      id="${question.id}-tab" type="button" role="tab" aria-controls="${question.id}-panel"
      aria-selected="${active ? "true" : "false"}" tabindex="${active ? "0" : "-1"}"
      aria-label="Question ${question.index} of ${question.total}: ${question.header}. ${question.complete ? "Answered" : "Unanswered"}">
      <span class="lmsa-ask-form-tab-number" aria-hidden="true">${question.index}</span>
      <span class="lmsa-ask-form-tab-label" aria-hidden="true">${question.header}</span>
      <span class="lmsa-ask-form-tab-status" aria-hidden="true"></span>
    </button>`;
  }).join("");
  const panels = questions
    .map((question, questionIndex) => question.html(questionIndex === activeIndex))
    .join("");
  return `<form class="lmsa-ask-form lmsa-interaction-form${collapsed ? " is-collapsed" : ""}">
    <div class="lmsa-interaction-toolbar">
      <div class="lmsa-ask-form-tabs" role="tablist" aria-label="Questions">${tabs}</div>
      <button class="lmsa-interaction-collapse" type="button"
        aria-label="${collapsed ? "Expand questions" : "Minimize questions"}"
        aria-controls="ask-visual-body" aria-expanded="${collapsed ? "false" : "true"}">
        ${collapsed ? I.chevronUp : I.chevronDown}
      </button>
    </div>
    <div class="lmsa-interaction-body" id="ask-visual-body" aria-hidden="${collapsed ? "true" : "false"}"${collapsed ? " inert" : ""}>
      <div class="lmsa-ask-form-questions">${panels}</div>
      <div class="lmsa-interaction-error${showError ? "" : " lmsa-hidden"}" role="alert">Answer every question before submitting.</div>
      <div class="lmsa-ask-form-actions">
        <button class="lmsa-ui-btn lmsa-ui-btn-primary lmsa-ask-form-submit" type="submit"${ready ? "" : " disabled"}>Submit answers</button>
      </div>
    </div>
  </form>`;
};

export const askComposerHtml = (questions, state) =>
  `<div class="lmsa-chat-composer">
    <button class="lmsa-chat-composer-generate-btn lmsa-hidden" aria-label="Generate response">
      <span class="lmsa-chat-composer-generate-icon">${I.sparkles}</span>
      <span>Generate response</span>
    </button>
    <div class="lmsa-chat-composer-interaction-body${state?.collapsed ? " is-collapsed" : ""}" aria-hidden="false">
      ${askForm(questions, state)}
    </div>
    <div class="lmsa-chat-composer-panel is-interacting is-ask-interaction">
      <div class="lmsa-context-picker-popover lmsa-hidden"></div>
      <div class="lmsa-chat-composer-normal-body" aria-hidden="true" inert>
        <div class="lmsa-chat-composer-chips">
          <button class="lmsa-chat-composer-add-context-btn" aria-label="Add context">${I.plus}</button>
        </div>
        <div class="lmsa-chat-composer-attachments"></div>
        <textarea class="lmsa-chat-composer-textarea" rows="1" disabled>An exact draft remains mounted here.</textarea>
      </div>
      ${composerFooter(true, true)}
    </div>
  </div>`;

// Real transcript markup, same as the approval stage: the conversation behind a drawer is
// the plugin's own, so a regression in message chrome is visible here too.
export const askStageHtml = (questions, state) =>
  `<div class="lmsa-ask-visual-stage">
    ${messagesPane(
      userMessage("<p>Help me decide how this handoff should be structured.</p>") +
        assistantProse(
          "<p>I need a few choices before I can finish the recommendation.</p>",
          "ask-prose-1",
        ) +
        userMessage("<p>Keep the answer practical and easy to review.</p>") +
        assistantProse(
          "<p>The form opens over this conversation without moving the composer.</p>",
          "ask-prose-2",
        ),
    )}
    ${askComposerHtml(questions, state)}
  </div>`;

export const singleIncompleteQuestion = askQuestion({
  id: "ask-single-q0",
  index: 1,
  total: 1,
  header: "Output",
  question: "Which output shape should I optimize for?",
  options: [
    { label: "Concise", description: "A short result focused on the final recommendation." },
    { label: "Detailed", description: "A fuller result with rationale, trade-offs, and examples." },
  ],
  other: {},
  incomplete: true,
});

export const otherReadyQuestion = askQuestion({
  id: "ask-other-q0",
  index: 1,
  total: 1,
  header: "Coverage",
  question: "Which areas should I cover in the handoff?",
  multi: true,
  options: [
    {
      label: "Testing",
      description: "Cover automated behavior and regression evidence.",
      checked: true,
    },
    {
      label: "Migration",
      description: "Explain compatibility and rollout concerns.",
    },
  ],
  other: {
    checked: true,
    text: "Include keyboard-only failure modes and provider recovery.",
  },
  complete: true,
});

export const mixedReadyQuestions = [
  askQuestion({
    id: "ask-mixed-q0",
    index: 1,
    total: 4,
    header: "Output",
    question: "Which output shape should I optimize for while keeping the final result easy to scan?",
    options: [
      { label: "Concise", description: "Lead with the recommendation and keep supporting detail compact." },
      {
        label: "Detailed",
        description: "Include rationale, trade-offs, implementation notes, and examples.",
        checked: true,
        focused: true,
      },
    ],
    other: {},
    complete: true,
  }),
  askQuestion({
    id: "ask-mixed-q1",
    index: 2,
    total: 4,
    header: "Coverage",
    question: "Which areas need explicit treatment in the implementation handoff?",
    multi: true,
    options: [
      { label: "Testing", description: "Cover automated behavior and regression evidence.", checked: true },
      { label: "Migration", description: "Explain compatibility and rollout concerns." },
      { label: "Accessibility", description: "Cover keyboard, focus, labels, and narrow layouts.", checked: true },
    ],
    other: {
      checked: true,
      text: "Include provider-failure recovery and submit/abort races.",
    },
    complete: true,
  }),
  askQuestion({
    id: "ask-mixed-q2",
    index: 3,
    total: 4,
    header: "Audience",
    question: "Who should the explanation assume will maintain this feature after the initial release?",
    options: [
      { label: "Plugin maintainer", description: "Assume familiarity with this repository and Obsidian APIs.", checked: true },
      { label: "New contributor", description: "Explain the architecture and local conventions from first principles." },
    ],
    other: {},
    complete: true,
  }),
  askQuestion({
    id: "ask-mixed-q3",
    index: 4,
    total: 4,
    header: "Emphasis",
    question: "Which qualities should be most visible in the final recommendation?",
    multi: true,
    options: [
      { label: "Readability", description: "Prefer code that is clear on first encounter.", checked: true },
      { label: "Development speed", description: "Keep future changes localized and low-boilerplate.", checked: true },
      { label: "Scalability", description: "Preserve a clean seam for later interaction kinds." },
    ],
    other: {},
    complete: true,
  }),
];

export const fillToCodePoints = (prefix, limit, glyph) =>
  prefix + glyph.repeat(limit - [...prefix].length);

export const maximumContractQuestions = Array.from({ length: 4 }, (_, questionIndex) => {
  const questionNumber = questionIndex + 1;
  return askQuestion({
    id: `ask-maximum-q${questionIndex}`,
    index: questionNumber,
    total: 4,
    header: fillToCodePoints(`Q${questionNumber} boundary!`, 12, "!"),
    question: fillToCodePoints(
      `Question ${questionNumber}: maximum valid model copy `,
      300,
      "q",
    ),
    multi: questionIndex % 2 === 1,
    options: Array.from({ length: 4 }, (_, optionIndex) => ({
      label: fillToCodePoints(
        `Q${questionNumber} option ${optionIndex + 1} `,
        40,
        "L",
      ),
      description: fillToCodePoints(
        `Question ${questionNumber}, option ${optionIndex + 1}: `,
        200,
        "d",
      ),
      checked: optionIndex === 0,
    })),
    other: questionIndex === 0
      ? {
          checked: true,
          text: fillToCodePoints("Maximum custom answer: ", 500, "a"),
        }
      : {},
    complete: true,
  });
});
