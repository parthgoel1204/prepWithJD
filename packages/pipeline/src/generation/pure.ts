/**
 * Pure question/flashcard sanitizers — deterministic, no LLM. Separated from
 * the generator so the id-linking rules are unit-testable without network.
 */
import type { Flashcard, Question, QuestionCategory, Requirement } from "../types";

const CATEGORIES: QuestionCategory[] = ["technical", "behavioural", "system-design", "company-fit"];

export function categoryOf(value: unknown): QuestionCategory {
  return (CATEGORIES as string[]).includes(value as string) ? (value as QuestionCategory) : "technical";
}

/**
 * Keep only questions whose requirement_ids all reference real requirement ids,
 * drop anything with zero requirement_ids (questions must be grounded in the JD),
 * clamp difficulty, and reassign stable contiguous ids.
 */
export function sanitizeQuestions(
  raw: Array<{ requirement_ids?: string[]; category?: string; prompt?: string; answer_outline?: string; difficulty?: number }>,
  knownIds: Set<string>,
  startIndex: number,
): { questions: Question[]; dropped: string[] } {
  const questions: Question[] = [];
  const dropped: string[] = [];
  let cursor = startIndex;
  for (const item of raw) {
    const prompt = (item.prompt ?? "").trim();
    const outline = (item.answer_outline ?? "").trim();
    if (!prompt || !outline) {
      dropped.push(`question missing prompt/outline -> dropped`);
      continue;
    }
    const reqIds = Array.from(new Set((item.requirement_ids ?? []).filter((x) => typeof x === "string")));
    if (reqIds.length === 0) {
      dropped.push(`question has no requirement_ids -> dropped: "${prompt.slice(0, 60)}"`);
      continue;
    }
    const bad = reqIds.filter((x) => !knownIds.has(x));
    if (bad.length > 0) {
      dropped.push(`question references missing requirements [${bad.join(",")}] -> dropped: "${prompt.slice(0, 60)}"`);
      continue;
    }
    const difficulty = Number(item.difficulty);
    questions.push({
      id: `q${++cursor}`,
      requirement_ids: reqIds,
      category: categoryOf(item.category),
      prompt,
      answer_outline: outline,
      difficulty: Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 3 ? difficulty : 2,
    });
  }
  return { questions, dropped };
}

export function sanitizeFlashcards(
  raw: Array<{ front?: string; back?: string; requirement_ids?: string[] }>,
  knownIds: Set<string>,
  startIndex: number,
): { flashcards: Flashcard[]; dropped: string[] } {
  const flashcards: Flashcard[] = [];
  const dropped: string[] = [];
  let cursor = startIndex;
  for (const item of raw) {
    const front = (item.front ?? "").trim();
    const back = (item.back ?? "").trim();
    if (!front || !back) {
      dropped.push(`flashcard missing front/back -> dropped`);
      continue;
    }
    const reqIds = Array.from(new Set((item.requirement_ids ?? []).filter((x) => typeof x === "string")));
    if (reqIds.length === 0 || reqIds.some((x) => !knownIds.has(x))) {
      dropped.push(`flashcard references missing/no requirements -> dropped: "${front.slice(0, 50)}"`);
      continue;
    }
    flashcards.push({ id: `f${++cursor}`, front, back, requirement_ids: reqIds });
  }
  return { flashcards, dropped };
}

export function hashStr(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
}

export function dedupeByIdentity<T extends { id: string; prompt?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const key = x.prompt ? hashStr(x.prompt.toLowerCase()) : x.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Compact one-line-per-requirement block handed to every category call. */
export function formatRequirements(requirements: Requirement[]): string {
  return requirements.map((r) => `${r.id} [${r.priority}] (${r.kind}) ${r.text}`).join("\n");
}