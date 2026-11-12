import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const int = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

export interface RunnerTimings {
  /** How long a lease lasts without renewal. */
  leaseTtlMs: number;
  /** How often the holder renews. Keep it well under the TTL. */
  leaseRenewMs: number;
  /** How often each server looks for runs whose lease expired. */
  sweepMs: number;
  /** How long events wait to be written together. */
  batchMs: number;
  /** How often a tailing reader polls when no notification arrives. */
  tailPollMs: number;
}

export const defaultTimings: RunnerTimings = {
  leaseTtlMs: int("RELAY_LEASE_TTL_MS", 15_000),
  leaseRenewMs: int("RELAY_LEASE_RENEW_MS", 5_000),
  sweepMs: int("RELAY_SWEEP_MS", 5_000),
  batchMs: int("RELAY_BATCH_MS", 50),
  tailPollMs: int("RELAY_TAIL_POLL_MS", 500),
};

export const config = {
  port: int("PORT", 4000),
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://relay:relay@localhost:5432/relay",
  agentUrl: process.env.AGENT_URL ?? "http://127.0.0.1:8123/agent",
  agentId: process.env.AGENT_ID ?? "support_desk",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
};

/**
 * Identifies this server process as a lease holder. It includes a random part
 * so a restarted process never matches the leases of the process it replaced.
 */
export const newHolderId = () => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
