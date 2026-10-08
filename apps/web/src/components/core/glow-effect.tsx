"use client";

import { cn } from "@/lib/utils";
import { motion, type Transition } from "motion/react";

export type GlowEffectProps = {
  className?: string;
  style?: React.CSSProperties;
  colors?: string[];
  mode?: "rotate" | "pulse" | "breathe" | "colorShift" | "flowHorizontal" | "flowVertical";
  blur?: number | "default" | "smallest" | "small" | "medium" | "large" | "xlarge";
  transition?: Transition;
  scale?: number;
  duration?: number;
};

const defaultColors = ["#a55eea", "#6c5ce7", "#74b9ff"];

const blurValues = {
  smallest: 2,
  small: 5,
  default: 10,
  medium: 20,
  large: 40,
  xlarge: 80,
} as const;

const modeTransitions: Record<string, Transition> = {
  rotate: { duration: 5, repeat: Infinity, ease: "linear" },
  pulse: { duration: 2, repeat: Infinity, ease: "easeInOut" },
  breathe: { duration: 3, repeat: Infinity, ease: "easeInOut" },
  colorShift: { duration: 6, repeat: Infinity, ease: "easeInOut" },
  flowHorizontal: { duration: 5, repeat: Infinity, ease: "linear" },
  flowVertical: { duration: 5, repeat: Infinity, ease: "linear" },
};

function animationFor(mode: GlowEffectProps["mode"], scale: number, duration: number, colors: string[]) {
  switch (mode) {
    case "pulse":
      return { animate: { opacity: [1, 0.25, 1] }, transition: { ...modeTransitions.pulse, duration } };
    case "breathe":
      return { animate: { scale: [scale, scale * 1.15, scale] }, transition: { ...modeTransitions.breathe, duration } };
    case "colorShift":
      return { animate: { background: colors, opacity: [0.5, 1, 0.5] }, transition: { ...modeTransitions.colorShift, duration } };
    case "flowHorizontal":
      return {
        animate: { x: ["-50%", "50%", "-50%"], y: ["-25%", "25%", "-25%"] },
        transition: { ...modeTransitions.flowHorizontal, duration },
      };
    case "flowVertical":
      return {
        animate: { x: ["-25%", "25%", "-25%"], y: ["-50%", "50%", "-50%"] },
        transition: { ...modeTransitions.flowVertical, duration },
      };
    default:
      return { animate: { rotate: [0, 360] }, transition: { ...modeTransitions.rotate, duration } };
  }
}

/**
 * Soft animated light behind a surface. Always decorative — pair with a card in
 * a relative container; the card sits on top with its own solid background.
 */
export function GlowEffect({
  className,
  style,
  colors = defaultColors,
  mode = "rotate",
  blur = "default",
  transition,
  scale = 1,
  duration = 5,
}: GlowEffectProps) {
  const blurValue = typeof blur === "number" ? blur : blurValues[blur] ?? 10;
  const { animate, transition: animTransition } = animationFor(mode, scale, duration, colors);
  const isColorShift = mode === "colorShift" || animate.background !== undefined;

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 opacity-70", isColorShift && "flex items-center justify-center", className)}
      style={{
        ...style,
        filter: `blur(${blurValue}px)`,
      }}
    >
      <motion.div
        className={cn(isColorShift && "h-full w-full", "bg-emerald-700")}
        style={{
          background: "linear-gradient(90deg, #a55eea, #6c5ce7, #74b9ff, #a55eea)",
        }}
        animate={animate}
        transition={transition ?? animTransition}
      />
    </div>
  );
}