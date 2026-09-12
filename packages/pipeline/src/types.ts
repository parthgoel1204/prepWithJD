/**
 * Shared type contract for prepWithJD.
 *
 * `KitContent` mirrors the non-negotiable JSON output contract from specs.md.
 * Field names are exact — extend only by ADDING fields, never renaming/removing.
 */

// ---------- enums pinned by the contract ----------
export type RequirementKind = "technical" | "behavioural" | "domain";
export type RequirementPriority = "must" | "nice";
export type QuestionCategory = "technical" | "behavioural" | "system-design" | "company-fit";
export type KitStatus = "draft" | "retrieving" | "retrieved" | "generated" | "failed";

// ---------- the output contract (specs.md) ----------
export interface KitSource {
  company: string;
  company_url: string;
  role: string;
  location: string;
  jd_chars: number;
  researched_at: string;
  pages_used: string[];
}

export interface CompanyBrief {
  summary: string;
  what_they_do: string;
  sources: string[];
}

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
}

export interface RoleBreakdown {
  title: string;
  seniority: string;
  responsibilities: string[];
  requirements: Requirement[];
}

export interface Question {
  id: string;
  requirement_ids: string[];
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  difficulty: number; // 1 | 2 | 3
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  requirement_ids: string[];
}

export interface ScheduleDay {
  day: number;
  focus: string;
  question_ids: string[];
  minutes: number;
}

export interface KitSchedule {
  days_available: number;
  days: ScheduleDay[];
}

export interface Coverage {
  uncovered_requirement_ids: string[];
  passes: number;
}

export interface KitContent {
  source: KitSource;
  company_brief: CompanyBrief;
  role: RoleBreakdown;
  questions: Question[];
  flashcards: Flashcard[];
  schedule: KitSchedule;
  coverage: Coverage;
}

// ---------- raw user input ----------
export interface KitInput {
  jd: string;
  company_url: string;
  days: number;
  file_name?: string;
}

// ---------- retrieval ----------
export type RetrievalStage = "fetch" | "robots" | "search" | "validate";

export interface RetrievalFailure {
  source_url: string;
  stage: RetrievalStage;
  code: string; // machine-readable, e.g. "DNS_FAILURE", "HTTP_429"
  message: string; // human-readable
  attempt?: number;
  occurred_at: string;
}

export interface CrawledPage {
  url: string;
  depth: number;
  via: string; // the url that linked to it
  title: string;
  text: string; // capped, whitespace-collapsed body text
  fetched_at: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchHits {
  items: SearchResultItem[];
  failures: RetrievalFailure[];
}

export interface RetrievalResult {
  company: string;
  pages: CrawledPage[];
  pages_used: string[];
  search_hits: SearchHits;
  failures: RetrievalFailure[];
}

export interface RetrievalOptions {
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  maxPages?: number;
  maxDepth?: number;
  maxCandidatesPerPage?: number;
  maxTextLength?: number;
  allowPrivateUrls?: boolean;
  userAgent?: string;
  statusCap?: number;
  searchApiKey?: string;
  searchBaseUrl?: string;
  searchTopK?: number;
  searchRatePerSecond?: number;
  searchBurst?: number;
}

// ---------- batch CLI contract (models designed so it reuses this) ----------
export interface EvaluateInput {
  id: string;
  jd: string;
  company_url: string;
  days: number;
}

export interface EvaluateKitResult {
  id: string;
  status: "ok" | "failed";
  kit: KitContent | null;
  error: string | null;
}

export interface EvaluateOutput {
  version: string;
  generated_at: string;
  kits: EvaluateKitResult[];
}