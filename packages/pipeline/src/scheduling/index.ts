import type { KitSchedule, Question } from "../types";
import { PipelineNotImplementedError } from "../errors";

export interface SchedulingContext {
  daysAvailable: number;
  questions: Question[];
}

/** Distributes questions across the available days + minutes budgets. */
export interface Scheduler {
  buildSchedule(ctx: SchedulingContext): Promise<KitSchedule>;
}

export class NotImplementedScheduler implements Scheduler {
  async buildSchedule(_ctx: SchedulingContext): Promise<KitSchedule> {
    throw new PipelineNotImplementedError("scheduling");
  }
}