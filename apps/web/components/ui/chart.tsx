'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import { cn } from '../../lib/utils';

// ─── Theme tokens ────────────────────────────────────────────────────────────
const THEMES = { light: '', dark: '.dark' } as const;

type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
    color?: string;
    theme?: Record<keyof typeof THEMES, string>;
  }
>;

// ─── Context ─────────────────────────────────────────────────────────────────
interface ChartContextProps {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error('useChart must be used within a ChartContainer');
  return ctx;
}

// ─── ChartContainer ──────────────────────────────────────────────────────────
interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config: ChartConfig;
  children: React.ReactNode;
}

function ChartContainer({ id, className, children, config, ...props }: ChartContainerProps) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn(
          'flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-ink-muted [&_.recharts-cartesian-grid_line]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke="#fff"]]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke="#ccc"]]:stroke-border/50 [&_.recharts-radial-bar-background-sector]:fill-muted/50 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/50 [&_.recharts-reference-line-line]:stroke-border/60 [&_.recharts-sector[stroke="#fff"]]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
      <ChartContext.Provider value={{ config }}>
        {/* intentional no-op — context consumed above */}
      </ChartContext.Provider>
    </ChartContext.Provider>
  );
}

// ─── Dynamic CSS for chart colors ───────────────────────────────────────────
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, c]) => c.color || c.theme);

  if (colorConfig.length === 0) return null;

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart="${id}"] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.color ?? '';
    const themeColors = itemConfig.theme?.[theme as keyof typeof itemConfig.theme];
    return themeColors
      ? `  --color-${key}: ${themeColors};`
      : `  --color-${key}: ${color};`;
  })
  .join('\n')}
}`,
          )
          .join('\n'),
      }}
    />
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
const ChartTooltip = RechartsPrimitive.Tooltip;

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: Record<string, unknown>; color?: string; dataKey?: string | number }>;
  label?: string;
  labelKey?: string;
  nameKey?: string;
  labelFormatter?: (label: string, payload: Array<{ name: string; value: number }>) => React.ReactNode;
  formatter?: (value: number, name: string, props: { color?: string }) => [React.ReactNode, string];
  indicator?: 'dot' | 'line' | 'dashed';
  hideLabel?: boolean;
  hideIndicator?: boolean;
  labelClassName?: string;
  indicatorClassName?: string;
  className?: string;
  dotClassName?: string;
  nameClassName?: string;
  valueClassName?: string;
  nestLabel?: boolean;
}

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  formatter,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  labelClassName = '',
  indicatorClassName = '',
  className = '',
  dotClassName = '',
  nameClassName = '',
  valueClassName = '',
  nestLabel = false,
  labelKey,
  nameKey,
}: ChartTooltipContentProps) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const value = !labelKey ? label : item?.payload?.[labelKey];

    if (labelFormatter) return <div className={cn('font-medium', labelClassName)}>{labelFormatter(String(value), payload)}</div>;
    if (!value) return null;
    return <div className={cn('font-medium', labelClassName)}>{String(value)}</div>;
  }, [label, labelFormatter, hideLabel, payload, labelClassName, labelKey]);

  if (!active || !payload?.length) return null;

  const nestLabelContent = nestLabel && tooltipLabel;

  return (
    <div className={cn('grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/60 bg-surface-900/95 px-2.5 py-1.5 text-xs shadow-xl backdrop-blur-sm', className)}>
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = `${nameKey || 'name'}`;
          const itemConfig = config[item.name as string] ?? {};
          const indicatorColor = item.color || `var(--color-${item.name})`;

          return (
            <div
              key={String(item.dataKey ?? item.name)}
              className={cn(
                'flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-ink-muted',
                indicator === 'dot' && 'items-center',
              )}
            >
              {formatter && item?.value !== undefined && item.name ? (
                formatter(item.value, item.name, item)
              ) : (
                <>
                  {!hideIndicator && (
                    <div
                      className={cn('h-2.5 w-2.5 shrink-0 rounded-[2px]', indicatorClassName)}
                      style={{
                        backgroundColor: indicator === 'line' || indicator === 'dashed' ? 'transparent' : indicatorColor,
                        border: indicator === 'dot' ? 'none' : `1px solid ${indicatorColor}`,
                      }}
                    />
                  )}
                  <div className={cn('flex flex-1 justify-between leading-none', nestLabel ? 'items-end' : 'items-center')}>
                    <div className={cn('grid gap-1.5', nameClassName)}>
                      {itemConfig.label && (
                        <span className="text-ink-muted">{itemConfig.label}</span>
                      )}
                      {!itemConfig.label && (
                        <span className="text-ink-muted">{item.name}</span>
                      )}
                    </div>
                    <span className={cn('font-mono font-medium tabular-nums text-ink-primary', valueClassName)}>
                      {item.value?.toLocaleString?.() ?? item.value}
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {nestLabel ? tooltipLabel : null}
    </div>
  );
}

// ─── Legend ──────────────────────────────────────────────────────────────────
const ChartLegend = RechartsPrimitive.Legend;

interface ChartLegendContentProps {
  className?: string;
  hideIcon?: boolean;
  payload?: Array<{ value: string; color?: string; type?: string }>;
  verticalAlign?: 'top' | 'bottom';
  nameKey?: string;
}

function ChartLegendContent({ className, hideIcon = false, payload, verticalAlign = 'bottom', nameKey }: ChartLegendContentProps) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <div className={cn('flex items-center justify-center gap-4', verticalAlign === 'top' ? 'pb-3' : 'pt-3', className)}>
      {payload.map((item) => {
        const key = `${nameKey || 'name'}`;
        const itemConfig = config[item.value] ?? {};
        const indicatorColor = item.color || `var(--color-${item.value})`;

        return (
          <div key={item.value} className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-ink-muted">
            {itemConfig.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: indicatorColor }} />
            )}
            {itemConfig.label}
          </div>
        );
      })}
    </div>
  );
}

// ─── Exports ─────────────────────────────────────────────────────────────────
export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, useChart };
export type { ChartConfig };
