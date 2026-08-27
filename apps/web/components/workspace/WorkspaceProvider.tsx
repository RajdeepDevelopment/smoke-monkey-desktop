'use client';

import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from 'react';

type BottomPanelState = 'hidden' | 'collapsed' | 'expanded' | 'pinned';
type ActivityPanel = 'explorer' | 'agent' | 'terminal' | 'search' | 'scm' | 'settings';

interface WorkspaceState {
  activePanel: ActivityPanel;
  sidePanelOpen: boolean;
  explorerWidth: number;
  agentWidth: number;
  terminalHeight: number;
  bottomPanelState: BottomPanelState;
}

type WorkspaceAction =
  | { type: 'SET_ACTIVE_PANEL'; panel: ActivityPanel }
  | { type: 'TOGGLE_SIDE_PANEL' }
  | { type: 'SET_SIDE_PANEL_OPEN'; open: boolean }
  | { type: 'SET_EXPLORER_WIDTH'; width: number }
  | { type: 'SET_AGENT_WIDTH'; width: number }
  | { type: 'SET_TERMINAL_HEIGHT'; height: number }
  | { type: 'SET_BOTTOM_PANEL_STATE'; state: BottomPanelState }
  | { type: 'EXPAND_BOTTOM_PANEL' }
  | { type: 'COLLAPSE_BOTTOM_PANEL' }
  | { type: 'PIN_BOTTOM_PANEL' }
  | { type: 'UNPIN_BOTTOM_PANEL' }
  | { type: 'LOAD_PERSISTED'; state: Partial<WorkspaceState> };

const STORAGE_KEY = 'sm-workspace-ui-v2';

function loadPersisted(): Partial<WorkspaceState> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      sidePanelOpen: parsed.sidePanelOpen,
      explorerWidth: parsed.explorerWidth,
      agentWidth: parsed.agentWidth,
      terminalHeight: parsed.terminalHeight,
      bottomPanelState: parsed.bottomPanelState,
      activePanel: parsed.activePanel,
    };
  } catch {
    return {};
  }
}

function persistState(state: WorkspaceState) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sidePanelOpen: state.sidePanelOpen,
      explorerWidth: state.explorerWidth,
      agentWidth: state.agentWidth,
      terminalHeight: state.terminalHeight,
      bottomPanelState: state.bottomPanelState,
      activePanel: state.activePanel,
    }));
  } catch { /* ignore */ }
}

const initialState: WorkspaceState = {
  activePanel: 'explorer',
  sidePanelOpen: false,
  explorerWidth: 240,
  agentWidth: 400,
      terminalHeight: 280,
  bottomPanelState: 'pinned',
};

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  let next: WorkspaceState;
  switch (action.type) {
    case 'SET_ACTIVE_PANEL':
      if (state.activePanel === action.panel && state.sidePanelOpen) {
        next = { ...state, sidePanelOpen: false };
      } else {
        next = { ...state, activePanel: action.panel, sidePanelOpen: true };
      }
      break;
    case 'TOGGLE_SIDE_PANEL':
      next = { ...state, sidePanelOpen: !state.sidePanelOpen };
      break;
    case 'SET_SIDE_PANEL_OPEN':
      next = { ...state, sidePanelOpen: action.open };
      break;
    case 'SET_EXPLORER_WIDTH':
      next = { ...state, explorerWidth: Math.max(180, Math.min(420, action.width)) };
      break;
    case 'SET_AGENT_WIDTH':
      next = { ...state, agentWidth: Math.max(320, Math.min(640, action.width)) };
      break;
    case 'SET_TERMINAL_HEIGHT':
      next = { ...state, terminalHeight: Math.max(100, Math.min(500, action.height)) };
      break;
    case 'SET_BOTTOM_PANEL_STATE':
      next = { ...state, bottomPanelState: action.state };
      break;
    case 'EXPAND_BOTTOM_PANEL':
      next = { ...state, bottomPanelState: state.bottomPanelState === 'pinned' ? 'pinned' : 'expanded' };
      break;
    case 'COLLAPSE_BOTTOM_PANEL':
      next = { ...state, bottomPanelState: state.bottomPanelState === 'pinned' ? 'pinned' : 'collapsed' };
      break;
    case 'PIN_BOTTOM_PANEL':
      next = { ...state, bottomPanelState: 'pinned' };
      break;
    case 'UNPIN_BOTTOM_PANEL':
      next = { ...state, bottomPanelState: 'expanded' };
      break;
    case 'LOAD_PERSISTED':
      next = { ...state, ...action.state };
      break;
    default:
      return state;
  }
  persistState(next);
  return next;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  setActivePanel: (panel: ActivityPanel) => void;
  toggleSidePanel: () => void;
  expandBottomPanel: () => void;
  collapseBottomPanel: () => void;
  pinBottomPanel: () => void;
  unpinBottomPanel: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, initialState);

  useEffect(() => {
    const persisted = loadPersisted();
    if (Object.keys(persisted).length > 0) {
      dispatch({ type: 'LOAD_PERSISTED', state: persisted });
    }
  }, []);

  const setActivePanel = useCallback((panel: ActivityPanel) => {
    dispatch({ type: 'SET_ACTIVE_PANEL', panel });
  }, []);

  const toggleSidePanel = useCallback(() => {
    dispatch({ type: 'TOGGLE_SIDE_PANEL' });
  }, []);

  const expandBottomPanel = useCallback(() => {
    dispatch({ type: 'EXPAND_BOTTOM_PANEL' });
  }, []);

  const collapseBottomPanel = useCallback(() => {
    dispatch({ type: 'COLLAPSE_BOTTOM_PANEL' });
  }, []);

  const pinBottomPanel = useCallback(() => {
    dispatch({ type: 'PIN_BOTTOM_PANEL' });
  }, []);

  const unpinBottomPanel = useCallback(() => {
    dispatch({ type: 'UNPIN_BOTTOM_PANEL' });
  }, []);

  return (
    <WorkspaceContext.Provider value={{
      state,
      dispatch,
      setActivePanel,
      toggleSidePanel,
      expandBottomPanel,
      collapseBottomPanel,
      pinBottomPanel,
      unpinBottomPanel,
    }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}

export type { WorkspaceState, ActivityPanel, BottomPanelState };
