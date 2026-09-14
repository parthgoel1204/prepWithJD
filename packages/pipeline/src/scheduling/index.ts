/**
 * Schedule allocation — PURE deterministic code, NO LLM anywhere in this module.
 *
 * Inputs: requirements, questions, days_available.
 * Deterministic sort: must-linked questions first (prioritise real coverage),
 * then difficulty desc (hardest first), then id asc (stable tiebreak).
 * Packs into exactly `days_available` day entries toward an ADAPTIVE per-day
 * target = ceil(total scheduled minutes / days available), with a sane floor of
 * ~15 min/day whenever there is material and NO hard ceiling. That means:
 *   - few days + heavy material -> high per-day minutes (cramming is realistic)
 *   - many days + light material -> the same material spreads thin across most
 *    /all days instead of clustering into the first 2-3.
 * Front-loading is preserved: must/harder questions still land on earlier days,
 * but they pack toward the adaptive target rather than a fixed 90-minute cap, so
 * material is never left over because packing stopped too early. If material
 * genuinely runs out before all days are used, later days stay at 0 min
 * ("Review / light day") — honest, not a bug.
 * Minutes are a difficulty-based constant (locked user decision): 1★=10, 2★=15,
 * 3★=20 per question, summed per day — INDEPENDENT of answer_outline length, so
 * totals are deterministic for a fixed difficulty set.
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

/** Locked difficulty → minutes map. Independent of answer_outline length. */
export const QUESTION_MINUTES: Record<number, number> = { 1: 10, 2: 15, 3: 20 };

/**
 * Never plan less than ~15 min/day while there is material at all: a thin
 * 60-day plan should still give each used day a real review-sized chunk rather
 * than shaving every day to a meaningless few minutes.
 */
export const MIN_DAILY_MINUTES = 15;

/**
 * Adaptive per-day target. ceil(total / days) with the floor above and no hard
 * ceiling: heavy material over few days legitimately targets 100+ min/day.
 * Returns 0 when there is no material (everything is a review day).
 */
export function adaptiveTargetMinutes(totalMinutes: number, days: number): number {
  if (totalMinutes <= 0 || days <= 0) return 0;
  return Math.max(Math.ceil(totalMinutes / days), MIN_DAILY_MINUTES);
}

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

  if (sorted.length === 0) {
    return { days_available: days, days: dayEntries };
  }

  const totalMinutes = sorted.reduce((sum, q) => sum + minutesForQuestion(q), 0);
  const target = adaptiveTargetMinutes(totalMinutes, days);

  // Front-loaded pack toward the adaptive target: a question goes on the
  // current day unless it would push that day measurably past target — only
  // then do we roll to the next day. An empty day always accepts a question
  // (no ceiling), so a single question larger than a small target still lands.
  let cur = 0;
  for (const q of sorted) {
    const mins = minutesForQuestion(q);
    while (
      cur + 1 < days &&
      dayEntries[cur]!.minutes > 0 &&
      dayEntries[cur]!.minutes + mins > target
    ) {
      cur++;
    }
    dayEntries[cur]!.question_ids.push(q.id);
    dayEntries[cur]!.minutes += mins;
  }

  for (const d of dayEntries) {
    const focusKey = dominantCategory(d.question_ids, byId);
    if (focusKey) d.focus = FOCUS_LABELS[focusKey] ?? focusKey;
  }

  return { days_available: days, days: dayEntries };
}