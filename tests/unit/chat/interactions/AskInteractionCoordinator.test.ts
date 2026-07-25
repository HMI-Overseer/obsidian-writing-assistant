import { describe, expect, it, vi } from "vitest";
import type {
  AskAnswers,
  AskCancellationReason,
  AskRequestContext,
} from "../../../../src/tools/ask/types";
import type {
  ComposerInteraction,
  ComposerInteractionHostPort,
} from "../../../../src/chat/interactions/ComposerInteractionHost";
import {
  AskInteractionCoordinator,
  AskInteractionPreconditionError,
  AskInteractionValidationError,
} from "../../../../src/chat/interactions/AskInteractionCoordinator";

const REQUEST = {
  questions: [{
    question: "Which output shape should I optimize for?",
    header: "Output",
    options: [
      { label: "Concise", description: "Keep the result brief." },
      { label: "Detailed", description: "Include rationale and examples." },
    ],
    multiSelect: false,
  }],
};

const ANSWERS: AskAnswers = {
  "Which output shape should I optimize for?": "Detailed",
};

class FakeHost implements ComposerInteractionHostPort {
  active: ComposerInteraction | null = null;
  readonly mounts: ComposerInteraction[] = [];
  readonly clears: string[] = [];

  mount(interaction: ComposerInteraction): boolean {
    if (this.active) return false;
    this.active = interaction;
    this.mounts.push(interaction);
    return true;
  }

  clearIfOwner(interactionId: string): void {
    if (this.active?.interactionId !== interactionId) return;
    this.clears.push(interactionId);
    this.active = null;
  }

  isActive(interactionId?: string): boolean {
    if (!this.active) return false;
    return interactionId === undefined || this.active.interactionId === interactionId;
  }

  destroy(): void {
    this.active = null;
  }
}

function context(interactionId: string, signal: AbortSignal): AskRequestContext {
  return {
    interactionId,
    toolCallId: `tool-${interactionId}`,
    signal,
  };
}

function submit(host: FakeHost, answers: AskAnswers = ANSWERS): void {
  const active = host.active;
  if (!active) throw new Error("No active interaction.");
  active.onSubmit(answers);
}

async function promiseStatus(promise: Promise<unknown>): Promise<string> {
  let status = "pending";
  void promise.then(
    () => {
      status = "resolved";
    },
    () => {
      status = "rejected";
    },
  );
  await Promise.resolve();
  return status;
}

describe("AskInteractionCoordinator", () => {
  it("validates before mounting", async () => {
    const controller = new AbortController();
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);

    await expect(
      coordinator.ask({ questions: [] }, context("ask-1", controller.signal)),
    ).rejects.toMatchObject({
      name: "AskInteractionValidationError",
      code: "questions_count",
    });
    expect(host.mounts).toHaveLength(0);
    expect(coordinator.hasPending()).toBe(false);
  });

  it("stays pending until a complete submission, then resolves and cleans up", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);

    const pending = coordinator.ask(REQUEST, context("ask-1", controller.signal));
    expect(await promiseStatus(pending)).toBe("pending");
    expect(host.isActive("ask-1")).toBe(true);

    submit(host);
    await expect(pending).resolves.toEqual(ANSWERS);
    expect(host.clears).toEqual(["ask-1"]);
    expect(coordinator.hasPending()).toBe(false);

    const abortListener = addSpy.mock.calls[0]?.[1];
    expect(addSpy).toHaveBeenCalledWith("abort", abortListener, { once: true });
    expect(removeSpy).toHaveBeenCalledWith("abort", abortListener);
  });

  it("refuses a second concurrent ask without replacing the first", async () => {
    const controller = new AbortController();
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);

    const first = coordinator.ask(REQUEST, context("ask-1", controller.signal));
    const second = coordinator.ask(REQUEST, context("ask-2", controller.signal));

    await expect(second).rejects.toMatchObject({
      name: "AskInteractionPreconditionError",
      code: "ask_concurrent",
    });
    expect(host.mounts).toHaveLength(1);
    expect(host.isActive("ask-1")).toBe(true);

    submit(host);
    await expect(first).resolves.toEqual(ANSWERS);
  });

  it("lets submit win over a later abort", async () => {
    const controller = new AbortController();
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);
    const pending = coordinator.ask(REQUEST, context("ask-1", controller.signal));

    submit(host);
    controller.abort();

    await expect(pending).resolves.toEqual(ANSWERS);
    expect(host.clears).toEqual(["ask-1"]);
  });

  it("lets abort win over a late submit with the repository AbortError shape", async () => {
    const controller = new AbortController();
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);
    const pending = coordinator.ask(REQUEST, context("ask-1", controller.signal));
    const lateSubmit = host.active?.onSubmit;

    controller.abort();
    lateSubmit?.(ANSWERS);

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "The request was aborted.",
    });
    expect(host.clears).toEqual(["ask-1"]);
  });

  it("settles only once across double submit and double cancellation", async () => {
    const controller = new AbortController();
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);
    const pending = coordinator.ask(REQUEST, context("ask-1", controller.signal));
    const submitTwice = host.active?.onSubmit;

    submitTwice?.(ANSWERS);
    submitTwice?.({
      "Which output shape should I optimize for?": "Concise",
    });
    coordinator.cancelPending("stopped");
    coordinator.cancelPending("stopped");

    await expect(pending).resolves.toEqual(ANSWERS);
    expect(host.clears).toEqual(["ask-1"]);

    const second = coordinator.ask(REQUEST, context("ask-2", controller.signal));
    coordinator.cancelPending("provider-failed");
    coordinator.cancelPending("destroyed");
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(host.clears).toEqual(["ask-1", "ask-2"]);
  });

  it("destroy cancels once and blocks later use", async () => {
    const controller = new AbortController();
    const host = new FakeHost();
    const coordinator = new AskInteractionCoordinator(host, controller.signal);
    const pending = coordinator.ask(REQUEST, context("ask-1", controller.signal));

    coordinator.destroy();
    coordinator.destroy();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      coordinator.ask(REQUEST, context("ask-2", controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(host.clears).toEqual(["ask-1"]);
  });

  it("exports typed validation and precondition errors for later tool routing", () => {
    expect(new AskInteractionValidationError({
      ok: false,
      code: "answer_incomplete",
      message: "Answer every question.",
    })).toMatchObject({
      name: "AskInteractionValidationError",
      code: "answer_incomplete",
    });
    expect(new AskInteractionPreconditionError()).toMatchObject({
      name: "AskInteractionPreconditionError",
      code: "ask_concurrent",
    });
  });

  it("accepts every cancellation reason through the responder contract", () => {
    const controller = new AbortController();
    const coordinator = new AskInteractionCoordinator(new FakeHost(), controller.signal);
    const reasons: AskCancellationReason[] = [
      "stopped",
      "conversation-switched",
      "new-conversation",
      "view-closed",
      "provider-failed",
      "superseded",
      "destroyed",
    ];

    for (const reason of reasons) coordinator.cancelPending(reason);
    expect(coordinator.hasPending()).toBe(false);
  });
});
