import { view } from "../scaffold.mjs";
import {
  askStageHtml,
  maximumContractQuestions,
  mixedReadyQuestions,
  otherReadyQuestion,
  singleIncompleteQuestion,
} from "../fixtures/ask.mjs";

export const ASK_SURFACES = {

  // Phase 2 ask interaction: one unanswered radio question. The local validation
  // message and disabled explicit submit action show the incomplete state.
  askSingleIncomplete: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml([singleIncompleteQuestion], {
        ready: false,
        showError: true,
      }),
      600,
    ),
  },

  // One ready multi-select question with the application-owned Other control
  // expanded, populated, and included alongside a model-authored choice.
  askOtherReady: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml([otherReadyQuestion], { ready: true }),
      600,
    ),
  },

  // Four ready question tabs mixing radios, checkboxes, long copy, and an
  // application-owned Other textarea with user text.
  askMixedReady: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(mixedReadyQuestions, { ready: true }),
      600,
    ),
  },

  // The same four-question drawer at narrow sidebar width. Its active panel stays
  // inside the bounded scroll region while navigation and Stop remain reachable.
  askMixedNarrow: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 320,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(mixedReadyQuestions, { ready: true }),
      320,
    ),
  },

  // Exact contract maximum: four questions, four options each, maximum model copy,
  // and one 500-code-point Other answer.
  askMaximumContract: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(maximumContractQuestions, { ready: true }),
      600,
    ),
  },

  // Exact contract maximum at the narrow sidebar width.
  askMaximumContractNarrow: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 320,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(maximumContractQuestions, { ready: true }),
      320,
    ),
  },

  // The minimized drawer keeps its tab state and restore control while exposing
  // the transcript behind it.
  askMixedMinimized: {
    source: "src/chat/composer/AskQuestionForm.ts",
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(mixedReadyQuestions, {
        ready: true,
        collapsed: true,
      }),
      600,
    ),
  },
};
