import type { CompanyBrief, CrawledPage, Requirement } from "../types";
import { PipelineNotImplementedError } from "../errors";

export interface ExtractionContext {
  jd: string;
  company: string;
  pages: CrawledPage[];
}

/** Pure extraction: researched pages + JD -> structured brief / requirement obligations. */
export interface Extractor {
  extractCompanyBrief(ctx: ExtractionContext): Promise<CompanyBrief>;
  /** Extract ONLY claims grounded in the JD text — never invented requirements. */
  extractRequirements(ctx: ExtractionContext): Promise<{ title: string; seniority: string; responsibilities: string[]; requirements: Requirement[] }>;
  /** If the JD is thin, report which sections are thin/absent so the UI can say so. */
  coverageGaps(ctx: ExtractionContext): Promise<string[]>;
}

export class NotImplementedExtractor implements Extractor {
  async extractCompanyBrief(_ctx: ExtractionContext): Promise<CompanyBrief> {
    throw new PipelineNotImplementedError("extraction");
  }
  async extractRequirements(
    _ctx: ExtractionContext,
  ): Promise<{ title: string; seniority: string; responsibilities: string[]; requirements: Requirement[] }> {
    throw new PipelineNotImplementedError("extraction");
  }
  async coverageGaps(_ctx: ExtractionContext): Promise<string[]> {
    throw new PipelineNotImplementedError("extraction");
  }
}