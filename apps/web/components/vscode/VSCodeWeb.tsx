'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

interface VSCodeWebProps {
  workspacePath?: string;
  className?: string;
}

const VSCODE_SERVER_URL = 'http://localhost:8643';

export function VSCodeWeb({ workspacePath, className }: VSCodeWebProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if VS Code server is running
    const checkServer = async () => {
      try {
        const res = await fetch(`${VSCODE_SERVER_URL}/`, { method: 'HEAD' });
        if (res.ok) {
          setIsLoaded(true);
          setError(null);
        } else {
          setError('VS Code server returned error');
        }
      } catch (err) {
        setError('VS Code server not running. Start with: node apps/desktop/src-tauri/vscode-server/server.js');
      }
    };

    checkServer();
    const interval = setInterval(checkServer, 5000);
    return () => clearInterval(interval);
  }, []);

  const vscodeUrl = workspacePath
    ? `${VSCODE_SERVER_URL}/?folder=${encodeURIComponent(workspacePath)}`
    : VSCODE_SERVER_URL;

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full bg-background text-foreground', className)}>
        <div className="text-center space-y-4 max-w-md">
          <div className="text-6xl">⚡</div>
          <h2 className="text-xl font-semibold">VS Code Web Server</h2>
          <p className="text-sm text-ink-muted">{error}</p>
          <div className="bg-surface rounded-lg p-4 text-left">
            <p className="text-xs font-mono text-ink-muted">
              <code>cd apps/desktop/src-tauri/vscode-server</code>
              <br />
              <code>node server.js</code>
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('h-full w-full', className)}>
      <iframe
        ref={iframeRef}
        src={vscodeUrl}
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; microphone"
        title="VS Code Web"
      />
    </div>
  );
}

// Terminal WebSocket hook for real terminal integration
export function useTerminalSocket(terminalId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:8643/terminal`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'create',
        id: terminalId,
        cols: 80,
        rows: 24,
      }));
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Handle terminal output
        if (msg.type === 'output') {
          // Emit to xterm.js or similar
        }
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [terminalId]);

  const sendInput = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'input',
        data,
      }));
    }
  };

  const resize = (cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'resize',
        cols,
        rows,
      }));
    }
  };

  const kill = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'kill',
      }));
    }
  };

  return { isConnected, sendInput, resize, kill };
}
