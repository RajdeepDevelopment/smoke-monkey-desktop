'use client';

import { memo, useMemo } from 'react';
import { ReactFlow, Background, Controls, MarkerType, Handle, Position } from '@xyflow/react';
import type { Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import { Boxes, Brain, Cpu, SquareCheckBig, Users, Workflow, Wrench, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * WORKFLOW / flow-diagram block. The model wraps JSON between
 * <workflow-st>…<workflow-ed>:
 *
 *   <workflow-st>
 *   {
 *     "title": "Agent loop",
 *     "nodes": [{ "id": "1", "label": "User", "type": "input" }, …],
 *     "edges": [{ "from": "1", "to": "2" }, …]
 *   }
 *   <workflow-ed>
 *
 * nodes[].type maps to a colored, icon-backed node:
 *   input · agent · tool · output · llm · database · default
 *
 * Rendered with @xyflow/react on a dotted canvas, laid out left-to-right by
 * dependency depth. Node/edge labels are escaped React text.
 */

interface NodeSpec {
  id: string;
  label?: string;
  type?: string;
}

interface WorkflowData {
  title?: string;
  nodes?: unknown;
  edges?: unknown;
}

export function parseWorkflow(json: string): WorkflowData | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    return {
      title: typeof o.title === 'string' ? o.title : undefined,
      nodes: Array.isArray(o.nodes) ? o.nodes : undefined,
      edges: Array.isArray(o.edges) ? o.edges : undefined,
    };
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

const NODE_PRESETS: Record<string, { icon: LucideIcon; accent: string; ring: string }> = {
  input: { icon: Users, accent: 'text-emerald-400', ring: 'border-emerald-500/40 bg-emerald-500/5' },
  agent: { icon: Brain, accent: 'text-violet-400', ring: 'border-violet-500/40 bg-violet-500/5' },
  llm: { icon: Cpu, accent: 'text-violet-400', ring: 'border-violet-500/40 bg-violet-500/5' },
  tool: { icon: Wrench, accent: 'text-sky-400', ring: 'border-sky-500/40 bg-sky-500/5' },
  output: { icon: SquareCheckBig, accent: 'text-amber-400', ring: 'border-amber-500/40 bg-amber-500/5' },
  database: { icon: Boxes, accent: 'text-rose-400', ring: 'border-rose-500/40 bg-rose-500/5' },
};

function WidgetNode({ data }: NodeProps<WidgetNode>) {
  const preset = NODE_PRESETS[data.type] ?? { icon: Zap, accent: 'text-ink-secondary', ring: 'border-surface-600 bg-surface-800' };
  const Icon = preset.icon;
  return (
    <div
      className={cn(
        'flex min-w-[120px] max-w-[190px] items-center gap-2 rounded-xl border px-3 py-2 shadow-[0_4px_16px_-6px_rgba(0,0,0,0.6)] backdrop-blur',
        preset.ring,
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-none !bg-ink-muted" />
      <Icon className={cn('h-4 w-4 shrink-0', preset.accent)} />
      <span className="truncate text-[12px] font-medium leading-tight text-foreground">{data.label}</span>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-none !bg-ink-muted" />
    </div>
  );
}

const nodeTypes: NodeTypes = { widget: WidgetNode };

type WidgetData = {
  label: string;
  type: string;
};

type WidgetNode = Node<WidgetData, 'widget'>;

interface FlowEdge {
  from: string;
  to: string;
}

const NODE_W = 170;
const NODE_H = 46;
const COL_GAP = 90;
const ROW_GAP = 26;

function layout(nodes: NodeSpec[], edges: FlowEdge[]): { nodes: WidgetNode[]; edges: Edge[]; w: number; h: number } {
  const out = new Map<string, string[]>();
  nodes.forEach((n) => out.set(n.id, []));
  edges.forEach((e) => out.get(e.from)?.push(e.to));

  const layer = new Map<string, number>();
  const visit = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    layer.set(id, 0);
    let best = 0;
    for (const child of out.get(id) ?? []) {
      if (child === id) continue;
      best = Math.max(best, 1 + visit(child));
    }
    layer.set(id, best);
    return best;
  };
  nodes.forEach((n) => visit(n.id));

  const byLayer = new Map<number, string[]>();
  nodes.forEach((n) => {
    const l = layer.get(n.id) ?? 0;
    byLayer.set(l, [...(byLayer.get(l) ?? []), n.id]);
  });

  const flowNodes: WidgetNode[] = nodes.map((n) => {
    const l = layer.get(n.id) ?? 0;
    const ids = byLayer.get(l) ?? [];
    const i = ids.indexOf(n.id);
    return {
      id: n.id,
      position: { x: 10 + l * (NODE_W + COL_GAP), y: 20 + (i - (ids.length - 1) / 2) * (NODE_H + ROW_GAP) },
      type: 'widget',
      data: { label: str(n.label ?? n.id), type: str(n.type ?? 'default') },
    };
  });

  const flowEdges: Edge[] = edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.from,
    target: e.to,
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: '#52525b', strokeWidth: 1.5 },
  }));

  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  flowNodes.forEach((n) => {
    maxX = Math.max(maxX, n.position.x + NODE_W);
    maxY = Math.max(maxY, n.position.y + NODE_H);
    minY = Math.min(minY, n.position.y);
  });

  return { nodes: flowNodes, edges: flowEdges, w: Math.max(420, maxX + 20), h: Math.max(220, maxY - minY + 80) };
}

/** Renders a <workflow-st>…<workflow-ed> JSON body as an interactive flow diagram. */
export const WorkflowBlock = memo(function WorkflowBlock({ json }: { json: string }) {
  const parsed = useMemo(() => parseWorkflow(json), [json]);
  const isClient = typeof window !== 'undefined';

  const spec = useMemo(() => {
    if (!parsed) return null;
    const nodes = (parsed.nodes ?? []) as unknown[];
    const edges = (parsed.edges ?? []) as unknown[];
    const nodeSpecs = nodes
      .map((n): NodeSpec | null => {
        if (typeof n !== 'object' || n === null) return null;
        const o = n as Record<string, unknown>;
        const id = str(o.id ?? o.name);
        return id ? { id, label: str(o.label ?? o.name ?? id), type: str(o.type ?? o.role) } : null;
      })
      .filter(Boolean) as NodeSpec[];
    const edgeSpecs = edges
      .map((e: unknown): { from: string; to: string } | null => {
        if (typeof e !== 'object' || e === null) return null;
        const o = e as Record<string, unknown>;
        const from = str(o.from ?? o.source);
        const to = str(o.to ?? o.target);
        return from && to ? { from, to } : null;
      })
      .filter(Boolean) as { from: string; to: string }[];
    return layout(nodeSpecs, edgeSpecs);
  }, [parsed]);

  if (!parsed || !spec || spec.nodes.length === 0) {
    return (
      <div className="my-1.5 rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-[11px] text-ink-muted">
        Couldn’t render workflow block.
      </div>
    );
  }

  return (
    <section className="premium-card relative my-1.5 overflow-hidden rounded-lg border border-surface-700 bg-gradient-to-b from-surface-850 to-surface-900 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.5)]">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <header className="flex items-center gap-2 border-b border-surface-700/60 bg-gradient-to-b from-white/[0.02] to-transparent px-2.5 py-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-violet-500/10">
          <Workflow className="h-3 w-3 text-violet-400" />
        </span>
        {parsed.title && (
          <h4 className="truncate text-[11px] font-semibold tracking-tight text-foreground">{parsed.title}</h4>
        )}
        <span className="ml-auto rounded-full bg-surface-800 px-1.5 py-px text-[9.5px] font-medium tabular-nums text-ink-muted">
          {spec.nodes.length} nodes
        </span>
      </header>
      <div className="p-1.5">
        {isClient && spec ? (
          <div style={{ height: spec.h }} className="w-full overflow-hidden rounded-lg border border-surface-800 bg-[#0b0d12]/80">
            <ReactFlow
              nodes={spec.nodes}
              edges={spec.edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              minZoom={0.4}
              maxZoom={1.6}
              proOptions={{ hideAttribution: true }}
              className="!bg-transparent"
            >
              <Background gap={20} size={1} color="#27272a" />
              <Controls position="bottom-right" showInteractive={false} className="!bg-surface-800 [&_button]:!border-surface-700 [&_button]:!bg-surface-800 [&_button]:text-ink-secondary" />
            </ReactFlow>
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center text-[11px] text-ink-muted">Loading flow…</div>
        )}
      </div>
    </section>
  );
});