/**
 * Desktop notification helpers for the agent.
 *
 * Uses the browser Notification API (works inside Tauri webview).
 * Only fires when the document is hidden (app in background) so the
 * user is never double-notified when they're already looking at the app.
 */

/** True when the browser/tab is not visible (minimised, covered, switched away). */
function isAppBackgrounded(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

/** Request notification permission (call once on mount). */
export async function requestNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;
  try {
    await Notification.requestPermission();
  } catch {
    // Some Tauri builds or restricted contexts throw — silently ignore.
  }
}

/**
 * Send a desktop notification, but ONLY if the app is in the background.
 * Returns true if a notification was actually sent.
 */
export function notifyIfBackgrounded(title: string, body: string, tag?: string): boolean {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  if (!isAppBackgrounded()) return false;

  try {
    new Notification(title, {
      body,
      tag: tag || 'sm-agent',
      icon: '/smoke-monkey-icon.png',
      requireInteraction: true,
    });
    return true;
  } catch {
    return false;
  }
}
