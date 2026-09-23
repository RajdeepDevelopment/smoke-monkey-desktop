'use client';

import * as React from 'react';
import { Bar, BarChart as RechartsBarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from './chart';
import { cn } from '../../lib/utils';

export interface BarChartDatum {
  [key: string]: string | number;
}

interface BarChartProps {
  data: BarChartDatum[];
  dataKey: string;
  config: ChartConfig;
  xKey?: string;
  xAxisDataKey?: string;
  stacked?: boolean;
  radius?: [number, number, number, number];
  className?: string;
  showLegend?: boolean;
  tickFormatter?: (value: number | string, index: number) => string;
  yTickFormatter?: (value: number | string, index: number) => string;
  barSize?: number;
  /** Auto-register every entry in data's extra keys as series. */
  series?: string[];
}

export function BarChart({
  data,
  dataKey,
  config,
  xKey = 'name',
  xAxisDataKey,
  stacked = false,
  radius = [6, 6, 0, 0],
  className,
  showLegend = false,
  tickFormatter,
  yTickFormatter,
  barSize,
  series,
}: BarChartProps) {
  const xAxisKey = xAxisDataKey ?? xKey;
  const seriesKeys = Array.isArray(series) && series.length > 0 ? series : [dataKey];
  const xTickFormatter = tickFormatter ?? ((v: string | number) => String(v));

  return (
    <ChartContainer config={config} className={cn('h-[260px] w-full', className)}>
      <RechartsBarChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }} barSize={barSize}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xAxisKey} tickLine={false} tickMargin={8} axisLine={false} tickFormatter={xTickFormatter} />
        <YAxis tickLine={false} tickMargin={8} axisLine={false} width={36} tickFormatter={yTickFormatter} />
        <ChartTooltip
          cursor={{ fill: 'hsl(var(--ink-primary) / 0.03)' }}
          content={<ChartTooltipContent indicator="line" />}
        />
        {seriesKeys.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            fill={`var(--color-${key})`}
            radius={radius}
            stackId={stacked ? 'stack' : undefined}
          />
        ))}
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      </RechartsBarChart>
    </ChartContainer>
  );
}