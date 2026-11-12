/**
 * One LISTEN connection per server process, shared by every reader.
 *
 * Notifications only say "something changed for this key". Readers then query
 * the log by sequence number, so a lost or duplicated notification costs a
 * little latency and nothing else. Readers also poll on a timer, which covers
 * the window while this connection is down and reconnecting.
 */

import pg from "pg";
import { CONTROL_CHANNEL, EVENTS_CHANNEL } from "./store.ts";

type Listener = () => void;

export class Notifier {
  private client: pg.Client | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    const reconnect = () => {
      if (this.client !== client) return;
      this.client = null;
      client.end().catch(() => {});
      if (!this.closed) this.retry = setTimeout(() => void this.connect().catch(() => {}), 1_000);
    };
    client.on("error", reconnect);
    client.on("end", reconnect);
    client.on("notification", (message) => {
      const key = `${message.channel}:${message.payload ?? ""}`;
      for (const listener of this.listeners.get(key) ?? []) listener();
    });
    this.client = client;
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}; LISTEN ${CONTROL_CHANNEL}`);
    } catch (error) {
      reconnect();
      throw error;
    }
  }

  /** Calls back whenever events are committed for a thread. Returns an unsubscribe function. */
  onThreadEvents(threadId: string, listener: Listener): () => void {
    return this.add(`${EVENTS_CHANNEL}:${threadId}`, listener);
  }

  /** Calls back when a stop is requested for a run. */
  onStopRequested(runId: string, listener: Listener): () => void {
    return this.add(`${CONTROL_CHANNEL}:${runId}`, listener);
  }

  private add(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
