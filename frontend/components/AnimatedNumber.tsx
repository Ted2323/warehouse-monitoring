"use client";

import { motion, useSpring, useTransform } from "framer-motion";
import { useEffect } from "react";

/**
 * Phase-3: spring-animated integer counter. Used by KPI tiles + the
 * compliance gauge so values roll up smoothly when the next /detect
 * response lands instead of snapping.
 *
 * The spring tuning matches the brief's reference (mass 0.8, stiffness 120,
 * damping 18) — softly underdamped so a 0 → 3 transition has a tiny
 * overshoot before settling, which reads as "live" rather than "static".
 */
export function AnimatedNumber({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const spring  = useSpring(value, { mass: 0.8, stiffness: 120, damping: 18 });
  const display = useTransform(spring, (v) => Math.round(v).toString());

  useEffect(() => { spring.set(value); }, [value, spring]);

  return <motion.span className={className}>{display}</motion.span>;
}
