'use client';

/**
 * Injects the Tailwind Play CDN once so add-on widgets always have full
 * utility coverage, even for classes Tailwind's build-time scanner never saw.
 *
 * Preflight is disabled so the CDN's global reset can't clash with the app's
 * own compiled Tailwind output — the CDN only *adds* missing utilities on
 * demand, scoped to whatever markup is live in the DOM.
 */
const CDN_SRC = 'https://cdn.tailwindcss.com';

let injected = false;

export function useTailwindCdn(): void {
  if (typeof window === 'undefined') return;

  if (!injected && !document.getElementById('tailwind-cdn')) {
    injected = true;

    // Config must be in place before the script runs (it reads window.tailwind).
    (window as unknown as { tailwind: object }).tailwind = {
      config: { corePlugins: { preflight: false } },
    };

    const script = document.createElement('script');
    script.id = 'tailwind-cdn';
    script.src = CDN_SRC;
    script.defer = true;
    document.head.appendChild(script);
  }
}
