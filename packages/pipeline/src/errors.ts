export class PipelineError extends Error {
  readonly code: string;
  readonly stage: string;

  constructor(message: string, code: string, stage: string) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.stage = stage;
  }
}

/** Thrown by stages that are intentionally not implemented yet (Day 1 stubs). */
export class PipelineNotImplementedError extends PipelineError {
  constructor(stage: string) {
    super(`${stage} is not implemented yet (Day 1 stub)`, "NOT_IMPLEMENTED", stage);
    this.name = "PipelineNotImplementedError";
  }
}