"use client";

import { AnimatePresence, motion } from "motion/react";
import type { Transition } from "motion/react";
import useMeasure from "react-use-measure";
import { Children, cloneElement, isValidElement, useId, useRef, useState, type ReactNode } from "react";

export type TransitionPanelProps = {
  children: ReactNode[];
  className?: string;
  transition?: Transition;
  activeIndex: number;
  renderAsSingleChild?: boolean;
};

const defaultTransition: Transition = { type: "spring", stiffness: 300, damping: 32 };

/**
 * Direction-aware panel that slides children in/out horizontally (tracks which
 * direction you moved) and animates its own height to the active child via
 * react-use-measure. The exiting child floats out position:absolute
 * (mode="popLayout"), so measured height stays that of the entering child.
 */
export function TransitionPanel({
  children,
  className,
  transition,
  activeIndex,
  renderAsSingleChild = false,
}: TransitionPanelProps) {
  const id = useId();
  const [ref, bounds] = useMeasure();
  const activeIndexRef = useRef(activeIndex);
  const [direction, setDirection] = useState(0);

  const hasMultipleChildren = Children.count(children) > 1;

  const activeChild = Children.toArray(children)[activeIndex];
  const keyed =
    renderAsSingleChild || !isValidElement(activeChild)
      ? activeChild
      : cloneElement(activeChild, { key: `${id}-${activeIndex}` as React.Key });

  return (
    <motion.div
      className={className}
      initial={false}
      animate={{ height: bounds.height ?? "auto" }}
      transition={transition ?? defaultTransition}
    >
      <div ref={ref}>
        <AnimatePresence
          mode="popLayout"
          initial={false}
          onExitComplete={() => {
            /* measurement re-reads next render */
          }}
        >
          <motion.div
            key={direction !== 0 ? `${id}-${activeIndex}` : `${id}-${activeIndex}-initial`}
            initial={{ opacity: 0, x: direction >= 0 ? 48 : -48, filter: "blur(4px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: direction >= 0 ? -48 : 48, filter: "blur(4px)" }}
            transition={transition ?? defaultTransition}
          >
            {keyed}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}