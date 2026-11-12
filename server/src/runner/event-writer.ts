/**
 * Persist, commit, then emit.
 *
 * Events from the agent are queued and written in small batches. Only after a
 * batch has committed are its events handed to the live client. So anything a
 * user has seen on screen is already in the log, and a crash can only lose
 * output that nobody saw.
 *
 * Some events are worth showing live but not worth keeping (see `isLiveOnly`).
 * They ride along in the queue to keep their place in the stream, skip the
 * database, and are emitted with their batch.
 */

import { EventType, type BaseEvent } from "@ag-ui/client";
import type { Db } from "../db.ts";
import { LeaseLostError, SaveFailedError } from "./errors.ts";
import { appendFenced, type Fence } from "./store.ts";

const LIVE_ONLY = new Set<string>([
  EventType.RAW,
  "REASONING_START",
  "REASONING_END",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_ENCRYPTED_VALUE",
]);

/** Shown to the live client, never stored, never replayed. */
export const isLiveOnly = (event: BaseEvent) => LIVE_ONLY.has(event.type);

export interface EventWriterOptions {
  db: Db;
  fence: Fence;
  batchMs: number;
  maxBatch?: number;
  /** Receives events after they are committed. */
  emit: (event: BaseEvent) => void;
  /** Called once, when a batch cannot be written. No further events are accepted. */
  onFailure: (error: LeaseLostError | SaveFailedError) => void;
}

export class EventWriter {
  private queue: BaseEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failure: LeaseLostError | SaveFailedError | null = null;

  constructor(private readonly options: EventWriterOptions) {}

  push(event: BaseEvent): void {
    if (this.failure) return;
    this.queue.push(event);
    if (this.queue.length >= (this.options.maxBatch ?? 200)) this.flushSoon(0);
    else this.flushSoon(this.options.batchMs);
  }

  private flushSoon(delayMs: number): void {
    if (delayMs === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, delayMs);
    }
  }

  /** Batches are written one after another, so the log keeps the agent's order. */
  private flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.failure || this.queue.length === 0) return;
      const batch = this.queue;
      this.queue = [];
      try {
        await appendFenced(
          this.options.db,
          this.options.fence,
          batch.filter((event) => !isLiveOnly(event)),
        );
      } catch (error) {
        this.failure = error instanceof LeaseLostError ? error : new SaveFailedError(error);
        this.queue = [];
        this.options.onFailure(this.failure);
        return;
      }
      for (const event of batch) this.options.emit(event);
    });
    return this.chain;
  }

  /** Writes whatever is still queued. Throws if any batch failed. */
  async drain(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
    if (this.failure) throw this.failure;
  }
}
