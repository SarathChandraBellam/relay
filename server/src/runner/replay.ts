/**
 * What a client receives when it opens a thread: the past, then the present.
 *
 *   1. History. Either one closed frame built from a safe snapshot, or, when
 *      there is no safe snapshot, the earlier runs replayed in compact form.
 *   2. The latest run's events from the log.
 *   3. If that run is still active, new events as they are committed, until
 *      the run ends.
 *
 * The same stream serves a reload, a second tab, a second device and a
 * request that lost a race to answer an approval. It reads only the log, so
 * it does not matter which server is driving the run.
 *
 * The output is a valid AG-UI stream from wherever the reader joins: every
 * frame opens with RUN_STARTED and every finished frame is closed.
 */

import { EventType, compactEvents, type BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { RunnerDeps } from "./execute-run.ts";
import { isActive } from "./status.ts";
import { findReplayAnchor, latestRun, readEventsAfter, reapExpired, type StoredEvent } from "./store.ts";

const PAGE = 1000;
const isTerminal = (event: BaseEvent) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;

export function replayThread(deps: RunnerDeps, threadId: string): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    let closed = false;
    let wake: (() => void) | null = null;
    const unsubscribe = deps.notifier.onThreadEvents(threadId, () => wake?.());

    /** Resolves on the next notification for this thread, or after the poll interval. */
    const nextChange = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, deps.timings.tailPollMs);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });

    const run = async () => {
      // If the driver died, say so now instead of showing a run that never moves.
      await reapExpired(deps.db, { threadId });

      // Status is read before the log. A run that ends in between is still
      // handled: its terminal event is in the log we are about to read.
      const latest = await latestRun(deps.db, threadId);
      if (!latest) return; // An unknown thread is an empty stream. Reading never creates one.
      const live = isActive(latest.status);
      const anchor = await findReplayAnchor(deps.db, threadId, latest.id);

      if (anchor.messages) {
        const frame = `history-${anchor.afterSeq}`;
        subscriber.next({ type: EventType.RUN_STARTED, threadId, runId: frame } as BaseEvent);
        subscriber.next(anchor.messages);
        if (anchor.state) subscriber.next(anchor.state);
        subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId: frame } as BaseEvent);
      }

      let cursor = anchor.afterSeq;
      const backlog: StoredEvent[] = [];
      for (;;) {
        const page = await readEventsAfter(deps.db, threadId, cursor, PAGE);
        backlog.push(...page);
        if (page.length > 0) cursor = page.at(-1)!.seq;
        if (page.length < PAGE) break;
      }

      const earlier = backlog.filter((stored) => stored.runId !== latest.id).flatMap((stored) => settled(stored.event));
      const current = backlog.filter((stored) => stored.runId === latest.id).map((stored) => stored.event);
      for (const event of compactEvents(earlier)) subscriber.next(event);
      // A finished run is compacted (one content event per message). A live
      // run is sent as written, so the tail continues it seamlessly.
      for (const event of live ? current : compactEvents(current)) subscriber.next(event);
      if (!live || current.some(isTerminal)) return;

      // Tail. Sequence order equals commit order, so "after cursor" never skips.
      while (!closed) {
        await nextChange();
        if (closed) return;
        const page = await readEventsAfter(deps.db, threadId, cursor, PAGE);
        for (const { seq, runId, event } of page) {
          cursor = seq;
          if (runId !== latest.id) return; // A newer run began; this frame is over.
          subscriber.next(event);
          if (isTerminal(event)) return;
        }
        if (page.length === 0) {
          // Nothing new. Make sure we are not waiting on a run that ended
          // without another event, then look once more.
          const now = await latestRun(deps.db, threadId);
          if (!now || now.id !== latest.id || !isActive(now.status)) {
            for (const { event } of await readEventsAfter(deps.db, threadId, cursor, PAGE)) subscriber.next(event);
            return;
          }
        }
      }
    };

    run().then(
      () => subscriber.complete(),
      (error) => subscriber.error(error),
    );
    return () => {
      closed = true;
      unsubscribe();
      wake?.();
    };
  });
}

/**
 * Prepares an event from an earlier run for replay. Earlier runs are over, so
 * any approval they asked for has been answered and must not be shown again.
 */
function settled(event: BaseEvent): BaseEvent[] {
  if (event.type === EventType.RUN_FINISHED && (event as { outcome?: { type?: string } }).outcome?.type === "interrupt") {
    const { outcome: _answered, ...rest } = event as BaseEvent & { outcome?: unknown };
    return [rest as BaseEvent];
  }
  if (event.type === EventType.CUSTOM && (event as { name?: string }).name === "on_interrupt") return [];
  return [event];
}
