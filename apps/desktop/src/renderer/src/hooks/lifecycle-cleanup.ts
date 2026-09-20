/**
 * Tiny helpers for timer / RAF cleanup used by chat UI cards.
 * Extracted so unmount-cancellation can be regression-tested without RTL.
 */

export type TimeoutHandle = ReturnType<typeof setTimeout>;

/** Schedule a timeout, clearing any previous handle first. */
export function replaceTimeout(
  current: TimeoutHandle | null,
  fn: () => void,
  ms: number,
): TimeoutHandle {
  if (current !== null) clearTimeout(current);
  return setTimeout(fn, ms);
}

/** Cancel a timeout handle if present. */
export function clearTimeoutHandle(current: TimeoutHandle | null): null {
  if (current !== null) clearTimeout(current);
  return null;
}

/** Schedule a rAF, cancelling any previous frame id first. */
export function replaceAnimationFrame(
  current: number | null,
  fn: FrameRequestCallback,
): number {
  if (current !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(current);
  }
  return requestAnimationFrame(fn);
}

/** Cancel a rAF id if present. */
export function clearAnimationFrame(current: number | null): null {
  if (current !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(current);
  }
  return null;
}
