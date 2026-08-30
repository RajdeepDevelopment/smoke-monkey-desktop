'use client';

import { useState } from 'react';
import { ChevronRight, ChevronDown, Copy, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AnsiText } from '../../lib/ansi';

interface Props {
  content: string;
  className?: string;
}

function parseToolOutput(content: string): { label: string; value: string; isCode: boolean }[] {
  const parts: { label: string; value: string; isCode: boolean }[] = [];
  const lines = content.split('\n');

  let currentPart: { label: string; value: string; isCode: boolean } | null = null;

  for (const line of lines) {
    if (line.startsWith('STDERR:') || line.startsWith('Error:') || line.startsWith('WARNING:')) {
      if (currentPart) parts.push(currentPart);
      currentPart = { label: line, value: '', isCode: true };
    } else if (currentPart) {
      currentPart.value += (currentPart.value ? '\n' : '') + line;
    } else {
      currentPart = { label: '', value: line, isCode: line.includes('\t') || line.startsWith('  ') || line.includes('│') };
    }
  }

  if (currentPart) parts.push(currentPart);
  if (parts.length === 0 && content) {
    parts.push({ label: '', value: content, isCode: content.includes('\n') || content.includes('\t') });
  }

  return parts;
}

export function ToolOutput({ content, className }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const parts = parseToolOutput(content);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn('text-xs', className)}>
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-ink-muted hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-medium">Output</span>
          <span className="opacity-50">({content.length} chars)</span>
        </button>
        <button onClick={handleCopy} className="text-ink-muted hover:text-foreground p-0.5">
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      {expanded && (
        <div className="mt-1 space-y-1">
          {parts.map((part, i) => (
            <div key={i}>
              {part.label && <p className="text-yellow-600 font-medium">{part.label}</p>}
              <pre className={cn(
                'max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-background/50 p-2',
                part.isCode && 'font-mono',
              )}>
                <AnsiText text={part.value} />
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
