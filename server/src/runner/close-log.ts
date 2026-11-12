import { EventType, type BaseEvent } from "@ag-ui/client";
import { finalizeRunEvents } from "@copilotkit/runtime/v2";

export type CloseReason =
  /** The user asked for a stop. The log ends with RUN_FINISHED. */
  | { stopped: true }
  /** The run broke off. The log ends with RUN_ERROR carrying this message and code. */
  | { message?: string; code?: string };

/**
 * Returns the events that bring a run's log to a proper end, given the events
 * it has so far: open messages, tool calls and steps are closed, then a
 * terminal event is added. Returns nothing if the log already ended.
 *
 * Whoever settles a run uses this, whether that is the driver itself or
 * another server cleaning up after it. The result is a log that any AG-UI
 * client accepts, so a partial answer stays readable.
 */
export function closeLog(seen: BaseEvent[], reason: CloseReason = {}): BaseEvent[] {
  const stopped = "stopped" in reason;
  const added = finalizeRunEvents(
    [...seen],
    stopped ? { stopRequested: true } : reason.message ? { interruptionMessage: reason.message } : {},
  ) as BaseEvent[];
  if (added.length === 0) return added;

  const openSteps: string[] = [];
  for (const event of seen) {
    const name = (event as { stepName?: string }).stepName;
    if (!name) continue;
    if (event.type === EventType.STEP_STARTED) openSteps.push(name);
    if (event.type === EventType.STEP_FINISHED) {
      const index = openSteps.lastIndexOf(name);
      if (index !== -1) openSteps.splice(index, 1);
    }
  }
  const stepClosers = openSteps.reverse().map((stepName) => ({ type: EventType.STEP_FINISHED, stepName }) as BaseEvent);

  const terminal = added.at(-1)!;
  if (!stopped && terminal.type === EventType.RUN_ERROR && reason.code) (terminal as { code?: string }).code = reason.code;
  return [...added.slice(0, -1), ...stepClosers, terminal];
}
