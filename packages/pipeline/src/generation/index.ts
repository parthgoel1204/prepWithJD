import type { CompanyBrief, Flashcard, Question, Requirement, RoleBreakdown } from "../types";
import { PipelineNotImplementedError } from "../errors";

export interface GenerationContext {
  jd: string;
  company: string;
  company_brief: CompanyBrief;
  role: RoleBreakdown;
}

/** Question/flashcard generation. Must never add requirements absent from the JD. */
export interface Generator {
  generateQuestions(ctx: GenerationContext, requirements: Requirement[]): Promise<Question[]>;
  generateFlashcards(ctx: GenerationContext, requirements: Requirement[], questions: Question[]): Promise<Flashcard[]>;
}

export class NotImplementedGenerator implements Generator {
  async generateQuestions(_ctx: GenerationContext, _requirements: Requirement[]): Promise<Question[]> {
    throw new PipelineNotImplementedError("generation");
  }
  async generateFlashcards(
    _ctx: GenerationContext,
    _requirements: Requirement[],
    _questions: Question[],
  ): Promise<Flashcard[]> {
    throw new PipelineNotImplementedError("generation");
  }
}