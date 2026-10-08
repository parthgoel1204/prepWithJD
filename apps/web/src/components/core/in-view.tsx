"use client";

import { motion, useInView, useReducedMotion, type Transition } from "motion/react";
import { useRef, type ReactNode } from "react";

export type InViewProps = {
  children: ReactNode;
  className?: string;
  /** Replaces the default hidden state (opacity 0, y 24, blur 4px). */
  initial?: Record<string, unknown> | false;
  /** Replaces the default visible state (opacity 1, y 0, blur 0). */
  during?: Record<string, unknown>;
  transition?: Transition;
  delay?: number;
};

/**
 * Fade + slight y-translate + blur-in when the element scrolls into view
 * (once). Respects prefers-reduced-motion by rendering a plain container.
 */
export function InView({
  children,
  className,
  initial,
  during,
  transition = { duration: 0.3, ease: "easeInOut" },
  delay = 0,
}: InViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduced = useReducedMotion();

  if (initial === false || reduced) {
    return <div className={className}>{children}</div>;
  }

  const hidden = { opacity: 0, y: 24, filter: "blur(4px)", ...(initial ?? {}) };
  const visible = { opacity: 1, y: 0, filter: "blur(0px)", ...(during ?? {}) };

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={hidden}
      animate={inView ? visible : hidden}
      transition={{ ...transition, delay }}
    >
      {children}
    </motion.div>
  );
}