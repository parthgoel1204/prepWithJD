"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Crossfades between string children with a tiny vertical drift. Used for live
 * status labels that swap between pipeline stages without a jarring blink.
 */
export function TextMorph({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [visible, setVisible] = useState<ReactNode>(children);

  useEffect(() => {
    const id = window.setTimeout(() => setVisible(children), 160);
    return () => window.clearTimeout(id);
  }, [children]);

  return (
    <span className={className}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={String(visible)}
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(4px)" }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          {visible}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}