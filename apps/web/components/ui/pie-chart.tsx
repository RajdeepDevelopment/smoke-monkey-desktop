'use client';

import { Pie, PieChart as RechartsPieChart, Cell } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from './chart';
import { cn } from '../../lib/utils';

export interface PieChartDatum {
  name: string;
  value: number;
  fill?: string;
}

interface PieChartProps {
  data: PieChartDatum[];
  config: ChartConfig;
  className?: string;
  innerRadius?: number;
  outerRadius?: number;
  showLegend?: boolean;
  tooltipValueFormatter?: (value: number) => string;
}

export function PieChart({
  data,
  config,
  className,
  innerRadius = 70,
  outerRadius = 100,
  showLegend = false,
  tooltipValueFormatter,
}: PieChartProps) {
  return (
    <ChartContainer config={config} className={cn('h-[260px] w-full', className)}>
      <RechartsPieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(value, _name, item) => [
                tooltipValueFormatter ? tooltipValueFormatter(value) : value.toLocaleString('en-US'),
                item.color ? '' : '',
              ]}
            />
          }
        />
        {showLegend && <ChartLegend content={<ChartLegendContent nameKey="name" />} />}
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          paddingAngle={3}
          strokeWidth={0}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.fill || `var(--color-${entry.name})`} />
          ))}
        </Pie>
      </RechartsPieChart>
    </ChartContainer>
  );
}