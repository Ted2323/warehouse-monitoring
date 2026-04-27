"use client";

import { useMemo } from "react";
import { PolarAngleAxis, RadialBar, RadialBarChart } from "recharts";
import { Card } from "@/components/Card";
import { AnimatedNumber } from "@/components/AnimatedNumber";

/**
 * Phase-3 compliance gauge — workers_compliant / workers_total as a
 * radial dial above the KPI tiles. Color tiers:
 *   ≥80% → success     (most workers compliant)
 *   50–79% → warning   (mixed)
 *   <50%   → critical  (most workers unsafe — alarm)
 *
 * Empty floor edge case (workers_total === 0): render full green ring +
 * "No workers in frame" caption so an empty camera frame doesn't show
 * as 0% red.
 *
 * Uses recharts RadialBarChart with a single bar and a fixed PolarAngleAxis
 * domain so the bar visually fills proportionally. recharts'
 * isAnimationActive defaults to true with ~1500ms duration; we trim it to
 * 800ms per the brief.
 */
export function ComplianceGauge({
  workersTotal,
  workersCompliant,
}: {
  workersTotal: number;
  workersCompliant: number;
}) {
  const isEmpty = workersTotal <= 0;
  const pct     = isEmpty ? 100 : Math.round((workersCompliant / workersTotal) * 100);

  const fill = useMemo(() => {
    if (isEmpty)    return "var(--success)";
    if (pct >= 80)  return "var(--success)";
    if (pct >= 50)  return "var(--warning)";
    return "var(--critical)";
  }, [pct, isEmpty]);

  // recharts wants an array; one entry, value = pct. We use PolarAngleAxis
  // with domain [0, 100] so the bar's length is the percentage, not a fraction
  // of the data array.
  const data = [{ name: "compliance", value: pct, fill }];

  return (
    <Card className="px-5 py-4 flex items-center gap-5">
      <div className="relative w-[120px] h-[120px] shrink-0" aria-label={`Compliance ${pct}%`}>
        <RadialBarChart
          width={120}
          height={120}
          cx="50%"
          cy="50%"
          innerRadius="72%"
          outerRadius="100%"
          barSize={10}
          startAngle={90}
          endAngle={-270}
          data={data}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={6}
            background={{ fill: "var(--bg-sunken)" }}
            isAnimationActive
            animationDuration={800}
          />
        </RadialBarChart>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="font-serif text-3xl leading-none" style={{ color: fill }}>
            <AnimatedNumber value={pct} />
            <span className="text-base ml-0.5">%</span>
          </span>
        </div>
      </div>

      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wider font-medium text-fg-muted mb-1">
          Worker compliance
        </div>
        {isEmpty ? (
          <p className="text-sm text-fg-subtle">No workers in frame</p>
        ) : (
          <p className="text-sm text-fg-muted">
            <span className="font-mono tabular-nums text-fg">
              <AnimatedNumber value={workersCompliant} />
            </span>
            {" of "}
            <span className="font-mono tabular-nums text-fg">
              <AnimatedNumber value={workersTotal} />
            </span>
            {" wearing helmet + vest"}
          </p>
        )}
      </div>
    </Card>
  );
}
