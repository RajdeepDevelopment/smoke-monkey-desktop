/**
 * Global external-link handling for the desktop webview.
 *
 * Problem: clicking any `<a href="https://...">` inside the Tauri webview
 * navigates the WHOLE window to that external site, leaving the user with no
 * way to get back. This listener runs in the capture phase (so it sees every
 * anchor, regardless of which markdown/rich-text renderer produced it),
 * intercepts external links, and opens them in the OS default browser instead
 * — keeping the app right where it is.
 *
 * Rule: a link is "external" when it has an http(s) URL whose host differs
 * from the app's own host. Relative links (`/chat`, `/agent`) are internal app
 * routes and are left untouched so normal in-app navigation keeps working.
 */

function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

let shellOpen:
  | ((url: string) => Promise<void>)
  | undefined;

async function getShellOpen() {
  try {
    const mod = await import('@tauri-apps/plugin-shell');
    shellOpen = mod.open;
  } catch {
    shellOpen = undefined;
  }
  return shellOpen;
}

function looksExternal(href: string, anchorOrigin: string): boolean {
  const lower = href.trim().toLowerCase();
  if (lower === '#' || lower === '' || lower.startsWith('#') || lower.startsWith('mailto:') || lower.startsWith('tel:')) {
    return false;
  }
  // Relative (no scheme, no leading `//`) URL → internal navigation.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(lower) && !lower.startsWith('//')) {
    return false;
  }
  // Protocol-relative or absolute http(s): external only if the host differs.
  try {
    const url = new URL(href, anchorOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin !== anchorOrigin;
  } catch {
    return true;
  }
}

let installed = false;

const openPromise = getShellOpen().then((o) => { shellOpen = o; });

/** Open a URL in the OS default browser (system browser on Tauri, new tab otherwise). */
export async function openExternalUrl(url: string): Promise<void> {
  await openPromise.catch(() => undefined);
  if (isTauri() && shellOpen) {
    await shellOpen(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Install the global handler. Idempotent — safe to call more than once. */
export function initExternalLinkHandling(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  document.addEventListener(
    'click',
    (e: MouseEvent) => {
      // Only handle plain left-clicks (no ctrl/cmd/shift/alt, no middle).
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target as Element | null;
      if (!target || !(target instanceof Element)) return;
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href') ?? anchor.href ?? '';
      const anchorOrigin = window.location.origin;
      if (!looksExternal(href, anchorOrigin)) return;

      // Intercept the in-webview navigation.
      e.preventDefault();
      e.stopPropagation();

      const url = new URL(href, anchorOrigin).href;
      void openExternalUrl(url);
    },
    true,
  );
}
