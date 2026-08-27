'use client';

import { useEffect } from 'react';
import { useWorkspace } from './WorkspaceProvider';

/** Global IDE shortcuts (⌘/Ctrl based):
 *  ⌘B toggle side panel · ⌘J toggle terminal panel
 *  ⌘⇧E Explorer · ⌘⇧F Search · ⌘⇧G SCM · ⌘⇧A Agent sessions */
export function WorkspaceShortcuts() {
  const { state, dispatch, setActivePanel } = useWorkspace();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (!e.shiftKey && key === 'b') {
        e.preventDefault();
        dispatch({ type: 'TOGGLE_SIDE_PANEL' });
      } else if (!e.shiftKey && key === 'j') {
        e.preventDefault();
        dispatch({
          type: 'SET_BOTTOM_PANEL_STATE',
          state: state.bottomPanelState === 'collapsed' ? 'expanded' : 'collapsed',
        });
      } else if (e.shiftKey && key === 'e') {
        e.preventDefault();
        setActivePanel('explorer');
      } else if (e.shiftKey && key === 'f') {
        e.preventDefault();
        setActivePanel('search');
      } else if (e.shiftKey && key === 'g') {
        e.preventDefault();
        setActivePanel('scm');
      } else if (e.shiftKey && key === 'a') {
        e.preventDefault();
        setActivePanel('agent');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.bottomPanelState, dispatch, setActivePanel]);

  return null;
}
