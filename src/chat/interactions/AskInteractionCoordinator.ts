import { createAbortError } from "../../api/httpTransport";
import type {
  AskAnswers,
  AskCancellationReason,
  AskRequestContext,
  AskUserResponder,
  AskValidationFailure,
  ValidatedAskRequest,
} from "../../tools/ask/types";
import {
  validateAskAnswers,
  validateAskRequest,
} from "../../tools/ask/validation";
import type {
  ComposerInteractionHostPort,
} from "./ComposerInteractionHost";

export class AskInteractionValidationError extends Error {
  readonly code: AskValidationFailure["code"];
  readonly issue: AskValidationFailure;

  constructor(issue: AskValidationFailure) {
    super(issue.message);
    this.name = "AskInteractionValidationError";
    this.code = issue.code;
    this.issue = issue;
  }
}

export class AskInteractionPreconditionError extends Error {
  readonly code = "ask_concurrent";

  constructor() {
    super("Another ask_user interaction is already pending.");
    this.name = "AskInteractionPreconditionError";
  }
}

interface PendingInteraction {
  interactionId: string;
  toolCallId: string;
  request: ValidatedAskRequest;
  abortListener: () => void;
  resolve: (answers: AskAnswers) => void;
  reject: (error: Error) => void;
}

type Settlement =
  | { kind: "submitted"; answers: AskAnswers }
  | { kind: "rejected"; error: Error };

export class AskInteractionCoordinator implements AskUserResponder {
  private pending: PendingInteraction | null = null;
  private destroyed = false;

  constructor(
    private readonly host: ComposerInteractionHostPort,
    private readonly signal: AbortSignal,
  ) {}

  ask(request: unknown, context: AskRequestContext): Promise<AskAnswers> {
    if (this.destroyed || this.signal.aborted || context.signal.aborted) {
      return Promise.reject(createAbortError());
    }
    if (this.pending) {
      return Promise.reject(new AskInteractionPreconditionError());
    }

    const validated = validateAskRequest(request);
    if (!validated.ok) {
      return Promise.reject(new AskInteractionValidationError(validated));
    }

    let resolvePromise!: (answers: AskAnswers) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<AskAnswers>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const abortListener = () => {
      this.settle(context.interactionId, {
        kind: "rejected",
        error: createAbortError(),
      });
    };
    this.pending = {
      interactionId: context.interactionId,
      toolCallId: context.toolCallId,
      request: validated.value,
      abortListener,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.signal.addEventListener("abort", abortListener, { once: true });

    try {
      const mounted = this.host.mount({
        kind: "ask",
        interactionId: context.interactionId,
        request: validated.value,
        onSubmit: (answers) => {
          this.submit(context.interactionId, answers);
        },
        onCancel: () => {
          this.settle(context.interactionId, {
            kind: "rejected",
            error: createAbortError(),
          });
        },
      });
      if (!mounted) {
        this.settle(context.interactionId, {
          kind: "rejected",
          error: new AskInteractionPreconditionError(),
        });
      }
    } catch (error) {
      this.settle(context.interactionId, {
        kind: "rejected",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    return promise;
  }

  cancelPending(_reason: AskCancellationReason): void {
    const interactionId = this.pending?.interactionId;
    if (!interactionId) return;
    this.settle(interactionId, {
      kind: "rejected",
      error: createAbortError(),
    });
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPending("destroyed");
  }

  private submit(interactionId: string, answers: AskAnswers): void {
    const pending = this.pending;
    if (!pending || pending.interactionId !== interactionId) return;
    const validated = validateAskAnswers(pending.request, answers);
    if (!validated.ok) {
      this.settle(interactionId, {
        kind: "rejected",
        error: new AskInteractionValidationError(validated),
      });
      return;
    }
    this.settle(interactionId, {
      kind: "submitted",
      answers: validated.value,
    });
  }

  private settle(interactionId: string, settlement: Settlement): void {
    const pending = this.pending;
    if (!pending || pending.interactionId !== interactionId) return;

    this.pending = null;
    this.signal.removeEventListener("abort", pending.abortListener);
    this.host.clearIfOwner(interactionId);
    if (settlement.kind === "submitted") {
      pending.resolve(settlement.answers);
    } else {
      pending.reject(settlement.error);
    }
  }
}
