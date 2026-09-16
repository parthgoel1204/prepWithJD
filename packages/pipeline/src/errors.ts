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
