import { Notice } from "obsidian";

/**
 * Surface a rejected promise to the user instead of leaving it unhandled.
 *
 * The plugin routes tool-call errors to the chat timeline (see the decorateError path); these
 * helpers are for UI-control handlers (Obsidian's `Setting.onClick`, DOM listeners, `setTimeout`,
 * the model selectors) that fire outside any timeline, so an unexpected rejection surfaces as a
 * Notice. A bare `void handler()` would satisfy the promise linters while silently dropping the
 * rejection, which is the failure mode these exist to prevent. The console line is developer
 * diagnostics for a genuine error; the Notice is what reaches the user.
 */
export function reportIfRejected(promise: Promise<unknown>, failureMessage: string): void {
  promise.catch((error: unknown) => {
    new Notice(failureMessage);
    console.error(failureMessage, error);
  });
}

/**
 * Adapt an async handler for a void-returning callback slot, surfacing any rejection via
 * {@link reportIfRejected}. Use it where the async work is written inline at the callback site;
 * where you already hold the promise (a named async method), call {@link reportIfRejected} directly.
 */
export function voidAsync<A extends unknown[]>(
  handler: (...args: A) => Promise<unknown>,
  failureMessage: string,
): (...args: A) => void {
  return (...args: A) => reportIfRejected(handler(...args), failureMessage);
}
