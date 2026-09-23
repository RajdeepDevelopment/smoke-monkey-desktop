'use client';

import { Area, AreaChart as RechartsAreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from './chart';
import { cn } from '../../lib/utils';

export interface AreaChartDatum {
  [key: string]: string | number;
}

interface AreaChartProps {
  data: AreaChartDatum[];
  config: ChartConfig;
  xKey?: string;
  stack?: boolean;
  className?: string;
  showLegend?: boolean;
  tickFormatter?: (value: string | number, index: number) => string;
  yTickFormatter?: (value: string | number, index: number) => string;
  series?: string[];
  fillOpacity?: number;
}

export function AreaChart({
  data,
  config,
  xKey = 'name',
  stack = false,
  className,
  showLegend = false,
  tickFormatter,
  yTickFormatter,
  series,
  fillOpacity = 0.28,
}: AreaChartProps) {
  const seriesKeys = Array.isArray(series) && series.length > 0 ? series : Object.keys(config);
  const xTick = tickFormatter ?? ((v: string | number) => String(v));

  return (
    <ChartContainer config={config} className={cn('h-[260px] w-full', className)}>
      <RechartsAreaChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
        <defs>
          {seriesKeys.map((key) => {
            const color = config[key]?.color;
            return (
              <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={fillOpacity + 0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} tickMargin={8} axisLine={false} tickFormatter={xTick} />
        <YAxis tickLine={false} tickMargin={8} axisLine={false} width={36} tickFormatter={yTickFormatter} />
        <ChartTooltip content={<ChartTooltipContent indicator="dot" />} cursor={{ stroke: 'hsl(var(--primary) / 0.35)', strokeWidth: 1, strokeDasharray: '3 3' }} />
        {seriesKeys.map((key) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            fill={`url(#fill-${key})`}
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            stackId={stack ? 'stack' : undefined}
          />
        ))}
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      </RechartsAreaChart>
    </ChartContainer>
  );
}