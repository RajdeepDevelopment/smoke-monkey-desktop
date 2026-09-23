'use client';

import { RadialBar, RadialBarChart as RechartsRadialBarChart } from 'recharts';
import { ChartContainer, type ChartConfig } from './chart';
import { cn } from '../../lib/utils';

export interface RadialChartDatum {
  name: string;
  value: number;
}

interface RadialChartProps {
  data: RadialChartDatum[];
  config: ChartConfig;
  className?: string;
  centerLabel?: string;
  centerSubLabel?: string;
}

export function RadialChart({ data, config, className, centerLabel, centerSubLabel }: RadialChartProps) {
  return (
    <ChartContainer config={config} className={cn('relative h-[260px] w-full', className)}>
      <RechartsRadialBarChart
        innerRadius="20%"
        outerRadius="100%"
        startAngle={90}
        endAngle={-270}
        data={data}
      >
        <RadialBar
          dataKey="value"
          cornerRadius={10}
          background={{ fill: 'hsl(var(--surface-700) / 0.5)' }}
          maxBarSize={16}
          isAnimationActive
        />
      </RechartsRadialBarChart>
      {centerLabel !== undefined && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-ink-primary">{centerLabel}</span>
          {centerSubLabel && <span className="text-[10.5px] text-ink-muted">{centerSubLabel}</span>}
        </div>
      )}
    </ChartContainer>
  );
}