/** Each error carries a stable `code` that reaches the client on RUN_ERROR. */
export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The thread already has a run in flight. CopilotKit matches on this code. */
export class ThreadBusyError extends RunnerError {
  constructor() {
    super("THREAD_ALREADY_RUNNING", "The agent is already running on this thread.");
  }
}

/** A message arrived while an approval is still waiting for an answer. */
export class ApprovalPendingError extends RunnerError {
  constructor() {
    super("APPROVAL_PENDING", "Complete the pending approval first.");
  }
}

/** An answer arrived for an approval that someone else already answered. */
export class AlreadyResumedError extends RunnerError {
  constructor() {
    super("ALREADY_RESUMED", "This approval was already answered.");
  }
}

/** This process no longer holds the run's lease. It must stop writing. */
export class LeaseLostError extends RunnerError {
  constructor() {
    super("LEASE_LOST", "This server no longer owns the run.");
  }
}

/** A batch of events could not be committed. */
export class SaveFailedError extends RunnerError {
  constructor(cause: unknown) {
    super("SAVE_FAILED", "Failed to save this response.");
    this.cause = cause;
  }
}
