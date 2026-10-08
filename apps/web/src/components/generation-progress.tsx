"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { GlowEffect } from "@/components/core/glow-effect";
import { TextMorph } from "@/components/core/text-morph";

const STAGE_LABELS: Record<"retrieving" | "generating", readonly string[]> = {
  retrieving: ["Retrieving company pages"],
  generating: ["Extracting requirements", "Generating questions", "Building schedule"],
} as const;

export function GenerationProgress({ phase }: { phase: "retrieving" | "generating" }) {
  const reduceMotion = useReducedMotion();
  const labels = STAGE_LABELS[phase];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (labels.length <= 1) return;
    const id = window.setInterval(() => setIndex((v) => (v + 1) % labels.length), 2500);
    return () => window.clearInterval(id);
  }, [labels]);

  const label = labels[Math.min(index, labels.length - 1)];

  return (
    <motion.div
      className="relative mt-4"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.2 } }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      {!reduceMotion && (
        <div aria-hidden className="absolute -inset-1.5">
          <GlowEffect mode="colorShift" blur="medium" colors={["#8b5cf6", "#6366f1", "#3b82f6"]} />
        </div>
      )}
      <div
        className="relative rounded-xl border border-zinc-950/10 bg-white px-5 py-4"
        role="status"
        aria-live="polite"
      >
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">
          {phase === "retrieving" ? "Retrieval" : "Generation"}
        </div>
        <div className="mt-1 text-sm font-medium text-zinc-900">
          {reduceMotion ? label : <TextMorph>{label}</TextMorph>}
        </div>
        <p className="mt-1 text-xs text-zinc-500">LLM calls take ~1–2 minutes.</p>
      </div>
    </motion.div>
  );
}
