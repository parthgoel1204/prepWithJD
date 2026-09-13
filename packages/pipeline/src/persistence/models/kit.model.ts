import { Schema, model, type Types } from "mongoose";
import type { KitContent, KitInput, KitStatus, RequirementKind, RequirementPriority } from "../../types";

// The sub-schemas mirror the non-negotiable output contract (specs.md) field-for-field.
const requirementSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    kind: { type: String, enum: ["technical", "behavioural", "domain"], default: "technical" as RequirementKind },
    priority: { type: String, enum: ["must", "nice"], default: "must" as RequirementPriority },
  },
  { _id: false },
);

const questionSchema = new Schema(
  {
    id: { type: String, required: true },
    requirement_ids: { type: [String], default: [] },
    category: { type: String, enum: ["technical", "behavioural", "system-design", "company-fit"], required: true },
    prompt: { type: String, default: "" },
    answer_outline: { type: String, default: "" },
    difficulty: { type: Number, min: 1, max: 3, default: 2 },
  },
  { _id: false },
);

const flashcardSchema = new Schema(
  {
    id: { type: String, required: true },
    front: { type: String, default: "" },
    back: { type: String, default: "" },
    requirement_ids: { type: [String], default: [] },
  },
  { _id: false },
);

const scheduleDaySchema = new Schema(
  {
    day: { type: Number, required: true },
    focus: { type: String, default: "" },
    question_ids: { type: [String], default: [] },
    minutes: { type: Number, min: 0, default: 60 },
  },
  { _id: false },
);

const discussionItemSchema = new Schema(
  {
    title: { type: String, default: "" },
    url: { type: String, default: "" },
    snippet: { type: String, default: "" },
  },
  { _id: false },
);

const robotsBlockedItemSchema = new Schema(
  {
    url: { type: String, default: "" },
    via: { type: String, default: "" },
    rule: { type: String, default: "" },
  },
  { _id: false },
);

const kitContentSchema = new Schema(
  {
    source: {
      company: { type: String, default: "" },
      company_url: { type: String, default: "" },
      role: { type: String, default: "" },
      location: { type: String, default: "" },
      jd_chars: { type: Number, default: 0 },
      researched_at: { type: String, default: "" },
      pages_used: { type: [String], default: [] },
      // Extended field (add-only per contract): search-API discussion hits.
      discussion: { type: [discussionItemSchema], default: [] },
      // Extended field: URLs skipped because robots.txt disallowed them (with the matched rule).
      robots_blocked: { type: [robotsBlockedItemSchema], default: [] },
    },
    company_brief: {
      summary: { type: String, default: "" },
      what_they_do: { type: String, default: "" },
      sources: { type: [String], default: [] },
    },
    role: {
      title: { type: String, default: "" },
      seniority: { type: String, default: "" },
      responsibilities: { type: [String], default: [] },
      requirements: { type: [requirementSchema], default: [] },
    },
    questions: { type: [questionSchema], default: [] },
    flashcards: { type: [flashcardSchema], default: [] },
    schedule: {
      days_available: { type: Number, default: 0 },
      days: { type: [scheduleDaySchema], default: [] },
    },
    coverage: {
      uncovered_requirement_ids: { type: [String], default: [] },
      passes: { type: Number, default: 0 },
    },
  },
  { _id: false },
);

export interface KitDoc {
  userId: Types.ObjectId;
  status: KitStatus;
  input: KitInput;
  content: KitContent;
  errorLog: string[];
  createdAt: Date;
  updatedAt: Date;
}

const kitSchema = new Schema<KitDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["draft", "retrieving", "retrieved", "generated", "failed"], default: "draft" },
    errorLog: { type: [String], default: [] },
    input: {
      jd: { type: String, required: true },
      company_url: { type: String, required: true },
      days: { type: Number, min: 1, max: 60, default: 5 },
      file_name: { type: String, default: "" },
    },
    content: { type: kitContentSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export const KitModel = model<KitDoc>("Kit", kitSchema);