"use client";

import { AnimatePresence, motion, type Variants } from "motion/react";
import type { Transition } from "motion/react";
import useMeasure from "react-use-measure";
import { Children, cloneElement, isValidElement, useId, useState, type ReactNode } from "react";

export type TransitionPanelProps = {
  children: ReactNode[];
  className?: string;
  transition?: Transition;
  activeIndex: number;
  renderAsSingleChild?: boolean;
};

const defaultTransition: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
  opacity: { duration: 0.2 },
};

const slideVariants: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 48 : -48, filter: "blur(4px)" }),
  center: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -48 : 48, filter: "blur(4px)" }),
};

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
  const [lastMove, setLastMove] = useState({ index: activeIndex, direction: 0 });
  const direction = lastMove.direction;

  if (lastMove.index !== activeIndex) {
    setLastMove({ index: activeIndex, direction: activeIndex > lastMove.index ? 1 : -1 });
  }

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
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div
            key={`${id}-${activeIndex}`}
            variants={slideVariants}
            custom={direction}
            initial="enter"
            animate="center"
            exit="exit"
            transition={transition ?? defaultTransition}
          >
            {keyed}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
