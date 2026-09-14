/**
 * Schedule allocation — PURE deterministic code, NO LLM anywhere in this module.
 *
 * Inputs: requirements, questions, days_available.
 * Deterministic sort: must-linked questions first (prioritise real coverage),
 * then difficulty desc (hardest first), then id asc (stable tiebreak).
 * Bin-packs into exactly `days_available` day entries (front-loaded: the
 * hardest work lands on day 1 and only spills to later days when capacity runs
 * out). Minutes are a difficulty-based constant (locked user decision): 1★=10,
 * 2★=15, 3★=20 per question, summed per day — INDEPENDENT of answer_outline
 * length, so totals are deterministic for a fixed difficulty set.
 */
import type { Question, Requirement, ScheduleDay, KitSchedule } from "../types";
import { PipelineNotImplementedError } from "../errors";

/**
 * Day-1 contract kept so the pipeline compiles until Step 8 wires the real
 * allocator. The production path uses the pure buildSchedule() function.
 */
export interface Scheduler {
  buildSchedule(input: { daysAvailable: number; questions: Question[] }): Promise<KitSchedule>;
}

export class NotImplementedScheduler implements Scheduler {
  async buildSchedule(_input: { daysAvailable: number; questions: Question[] }): Promise<KitSchedule> {
    throw new PipelineNotImplementedError("scheduling");
  }
}

export const DAY_CAPACITY_MINUTES = 90;

/** Locked difficulty → minutes map. Independent of answer_outline length. */
export const QUESTION_MINUTES: Record<number, number> = { 1: 10, 2: 15, 3: 20 };

const CATEGORY_ORDER = ["technical", "system-design", "behavioural", "company-fit"] as const;

// ---------- pure helpers ----------

/** Question minutes = fixed difficulty-based constant (1★=10, 2★=15, 3★=20). */
export function minutesForQuestion(q: Question): number {
  const d = Math.min(3, Math.max(1, Math.round(q.difficulty)));
  return QUESTION_MINUTES[d] ?? QUESTION_MINUTES[1]!;
}

function priorityOf(requirements: Requirement[]): Map<string, "must" | "nice" | "none"> {
  const map = new Map<string, "must" | "nice" | "none">();
  for (const r of requirements) map.set(r.id, map.get(r.id) ?? r.priority);
  return map;
}

/**
 * Sort: must-linked questions before nice-only questions, then difficulty
 * descending, then id ascending (deterministic). Deterministic for equal keys.
 */
export function sortByScheduleOrder(questions: Question[], requirements: Requirement[]): Question[] {
  const p = priorityOf(requirements);
  return [...questions].sort((a, b) => {
    const pa = a.requirement_ids.some((id) => p.get(id) === "must") ? 1 : 0;
    const pb = b.requirement_ids.some((id) => p.get(id) === "must") ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (a.difficulty !== b.difficulty) return b.difficulty - a.difficulty;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function dominantCategory(ids: string[], byId: Map<string, Question>): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const cat = byId.get(id)?.category;
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const cat of CATEGORY_ORDER) {
    const n = counts.get(cat) ?? 0;
    if (n > bestCount) {
      best = cat;
      bestCount = n;
    }
  }
  return best;
}

const FOCUS_LABELS: Record<string, string> = {
  technical: "Technical deep-dive",
  "system-design": "System design sprint",
  behavioural: "Behavioural practise",
  "company-fit": "Company-fit & storytelling",
};

// ---------- the allocator ----------

export function buildSchedule(
  requirements: Requirement[],
  questions: Question[],
  daysAvailable: number,
  capacityMinutes: number = DAY_CAPACITY_MINUTES,
): KitSchedule {
  const days = Math.max(1, Math.floor(daysAvailable));
  const byId = new Map(questions.map((q) => [q.id, q]));
  const sorted = sortByScheduleOrder(questions, requirements);

  const dayEntries: ScheduleDay[] = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    focus: "Review / light day",
    question_ids: [],
    minutes: 0,
  }));

  let cur = 0;
  for (const q of sorted) {
    const mins = minutesForQuestion(q);
    // find the first day (front-load) that still fits; spill only when it doesn't
    while (cur + 1 < days && dayEntries[cur]!.minutes + mins > capacityMinutes) cur++;
    dayEntries[cur]!.question_ids.push(q.id);
    dayEntries[cur]!.minutes += mins;
    if (dayEntries[cur]!.minutes > capacityMinutes) {
      console.warn(`[schedule] day ${cur + 1} oversubscribed (${dayEntries[cur]!.minutes} min > ${capacityMinutes}) — days_available too small`);
    }
  }

  for (const d of dayEntries) {
    const focusKey = dominantCategory(d.question_ids, byId);
    if (focusKey) d.focus = FOCUS_LABELS[focusKey] ?? focusKey;
  }

  return { days_available: days, days: dayEntries };
}