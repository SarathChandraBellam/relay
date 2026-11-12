import { describe, expect, it } from "vitest";
import { TRANSITIONS, canTransition, deriveThreadStatus, isBusy, toSimpleStatus, type RunStatus } from "../src/runner/status.ts";

describe("run state machine", () => {
  it("only running and stopping can move", () => {
    const atRest: RunStatus[] = ["resumed", "completed", "cancelled", "failed", "orphaned"];
    for (const status of atRest) expect(TRANSITIONS[status]).toEqual([]);
  });

  it("a stopping run can only end as cancelled", () => {
    expect(TRANSITIONS.stopping).toEqual(["cancelled"]);
    expect(canTransition("stopping", "completed")).toBe(false);
  });

  it("a parked run can only be resumed", () => {
    expect(TRANSITIONS.parked).toEqual(["resumed"]);
  });
});

describe("derived thread status", () => {
  const run = (status: RunStatus, leaseAlive = true, waitingFor: string | null = null) => ({ status, leaseAlive, waitingFor });

  it("is idle for a thread with no runs", () => {
    expect(deriveThreadStatus(null)).toBe("idle");
  });

  it("follows the latest run", () => {
    expect(deriveThreadStatus(run("running"))).toBe("running");
    expect(deriveThreadStatus(run("stopping"))).toBe("stopping");
    expect(deriveThreadStatus(run("completed", false))).toBe("idle");
    expect(deriveThreadStatus(run("failed", false))).toBe("error");
    expect(deriveThreadStatus(run("parked", false, "approval"))).toBe("waiting_approval");
    expect(deriveThreadStatus(run("parked", false, "client_tool"))).toBe("waiting_client_tool");
  });

  it("does not trust a running row whose lease has expired", () => {
    expect(deriveThreadStatus(run("running", false))).toBe("connection_lost");
    expect(deriveThreadStatus(run("stopping", false))).toBe("cancelled");
  });

  it("locks the composer only while running or stopping", () => {
    expect(isBusy("running")).toBe(true);
    expect(isBusy("stopping")).toBe(true);
    expect(isBusy("waiting_approval")).toBe(false);
    expect(isBusy("connection_lost")).toBe(false);
  });

  it("maps to the four-value view", () => {
    expect(toSimpleStatus("waiting_approval")).toBe("idle");
    expect(toSimpleStatus("connection_lost")).toBe("error");
  });
});
