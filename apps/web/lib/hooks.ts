'use client';

import { useEffect, useState } from 'react';

/** Reactive media-query hook. Returns whether the query currently matches. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** True below the lg breakpoint (1024px) — used for mobile-first layouts. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 1023px)');
}
