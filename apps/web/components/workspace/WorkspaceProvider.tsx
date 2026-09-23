'use client';

import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from 'react';

type BottomPanelState = 'hidden' | 'collapsed' | 'expanded' | 'pinned';
type ActivityPanel = 'explorer' | 'agent' | 'terminal' | 'search' | 'scm' | 'settings' | 'ssh';

/** How much of the power-user IDE to show. 'dev' = full workspace;
 *  'simple' = ChatGPT-style chat that still has files/terminal one tap away. */
export type UiMode = 'dev' | 'simple';

interface WorkspaceState {
  activePanel: ActivityPanel;
  sidePanelOpen: boolean;
  explorerWidth: number;
  agentWidth: number;
  terminalHeight: number;
  bottomPanelState: BottomPanelState;
  uiMode: UiMode;
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
  | { type: 'SET_UI_MODE'; mode: UiMode }
  | { type: 'LOAD_PERSISTED'; state: Partial<WorkspaceState> };

const STORAGE_KEY = 'sm-workspace-ui-v2';
/** Set by onboarding / settings — the provider uses it as the initial value. */
const MODE_KEY = 'sm-ui-mode';

function readStandaloneMode(): UiMode {
  if (typeof window === 'undefined') return 'dev';
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'dev' || raw === 'simple') return raw;
  } catch { /* ignore */ }
  return 'dev';
}

function loadPersisted(): Partial<WorkspaceState> {
  if (typeof window === 'undefined') return {};
  let parsed: { [K in keyof WorkspaceState]?: WorkspaceState[K] } = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch { /* ignore */ }

  // Deep link from the unified rail on other pages (?panel=<tab>) — always
  // wins over whatever was persisted so the panel opens on arrival.
  const panel = new URLSearchParams(window.location.search).get('panel');
  const valid = ['explorer', 'search', 'scm', 'agent', 'terminal', 'ssh', 'settings'];
  if (panel && valid.includes(panel)) {
    parsed.activePanel = panel as ActivityPanel;
    parsed.sidePanelOpen = true;
  }

  if (Object.keys(parsed).length === 0) return { uiMode: readStandaloneMode() };
  return {
    sidePanelOpen: parsed.sidePanelOpen,
    explorerWidth: parsed.explorerWidth,
    agentWidth: parsed.agentWidth,
    terminalHeight: parsed.terminalHeight,
    bottomPanelState: parsed.bottomPanelState,
    activePanel: parsed.activePanel,
    uiMode: parsed.uiMode === 'simple' ? 'simple' : parsed.uiMode === 'dev' ? 'dev' : readStandaloneMode(),
  };
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
      uiMode: state.uiMode,
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
  uiMode: 'dev',
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
      next = { ...state, agentWidth: Math.max(320, Math.min(820, action.width)) };
      break;
    case 'SET_UI_MODE':
      // Simple mode keeps dev-only chrome collapsed; switching back restores it.
      if (action.mode === 'simple') {
        next = {
          ...state,
          uiMode: action.mode,
          bottomPanelState: state.bottomPanelState === 'pinned'
            ? 'collapsed'
            : state.bottomPanelState,
          sidePanelOpen: false,
        };
      } else {
        next = { ...state, uiMode: action.mode };
      }
      try {
        localStorage.setItem(MODE_KEY, action.mode);
      } catch { /* ignore */ }
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
  setSidePanelOpen: (open: boolean) => void;
  toggleSidePanel: () => void;
  expandBottomPanel: () => void;
  collapseBottomPanel: () => void;
  pinBottomPanel: () => void;
  unpinBottomPanel: () => void;
  setUiMode: (mode: UiMode) => void;
  toggleUiMode: () => void;
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

  const setSidePanelOpen = useCallback((open: boolean) => {
    dispatch({ type: 'SET_SIDE_PANEL_OPEN', open });
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

  const setUiMode = useCallback((mode: UiMode) => {
    dispatch({ type: 'SET_UI_MODE', mode });
  }, []);

  const toggleUiMode = useCallback(() => {
    dispatch({ type: 'SET_UI_MODE', mode: state.uiMode === 'dev' ? 'simple' : 'dev' });
  }, [state.uiMode]);

  return (
    <WorkspaceContext.Provider value={{
      state,
      dispatch,
      setActivePanel,
      setSidePanelOpen,
      toggleSidePanel,
      expandBottomPanel,
      collapseBottomPanel,
      pinBottomPanel,
      unpinBottomPanel,
      setUiMode,
      toggleUiMode,
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
