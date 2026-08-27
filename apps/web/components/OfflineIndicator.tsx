'use client';

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Slim offline banner. Works in the browser and inside the Tauri webview:
 * reacts to `navigator.onLine` / online+offline events so users immediately
 * know chat and uploads need an internet connection.
 */
export function OfflineIndicator() {
  const [offline, setOffline] = useState(false);
  const [since, setSince] = useState<Date | null>(null);

  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      setSince(new Date());
    };
    const goOnline = () => {
      setOffline(false);
      setSince(null);
    };
    if (typeof navigator !== 'undefined' && !navigator.onLine) goOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!offline) return null;

  const message = since
    ? "You're offline — chat and document uploads need an internet connection."
    : "You're offline";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-amber-400/95 px-4 py-1.5 text-center text-xs font-semibold text-amber-950 shadow-lg backdrop-blur"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
