export const SM_THEME = 'smoke-monkey-dark';

/** Minimal structural type for the monaco namespace passed by @monaco-editor/react. */
interface MonacoNamespace {
  editor: {
    defineTheme: (name: string, theme: unknown) => void;
  };
}

/**
 * Defines the Smoke Monkey Monaco theme using the same design tokens as the
 * app shell (see app/globals.scss :root). Must be called in `beforeMount`.
 */
export function defineSmokeMonkeyTheme(monaco: MonacoNamespace): void {
  monaco.editor.defineTheme(SM_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5A6478', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'C0A6F7' },
      { token: 'keyword.control', foreground: 'C0A6F7' },
      { token: 'string', foreground: '9CC98F' },
      { token: 'string.yaml', foreground: '9CC98F' },
      { token: 'number', foreground: 'E8B36B' },
      { token: 'regexp', foreground: '6FD3C7' },
      { token: 'type', foreground: '7EE0D2' },
      { token: 'type.identifier', foreground: '7EE0D2' },
      { token: 'class', foreground: '7EE0D2' },
      { token: 'struct', foreground: '7EE0D2' },
      { token: 'interface', foreground: '7EE0D2' },
      { token: 'enum', foreground: '7EE0D2' },
      { token: 'function', foreground: '8FB8F5' },
      { token: 'method', foreground: '8FB8F5' },
      { token: 'variable', foreground: 'E6EAF2' },
      { token: 'variable.predefined', foreground: 'C792EA' },
      { token: 'constant', foreground: 'E8B36B' },
      { token: 'operator', foreground: '9AA5B8' },
      { token: 'delimiter', foreground: '8B95A7' },
      { token: 'tag', foreground: 'F28B96' },
      { token: 'attribute.name', foreground: 'C0A6F7' },
      { token: 'attribute.value', foreground: '9CC98F' },
      { token: 'metatag', foreground: 'C0A6F7' },
      { token: 'annotation', foreground: 'E8B36B' },
      { token: 'key', foreground: '8FB8F5' },
      { token: 'identifier', foreground: 'E6EAF2' },
    ],
    colors: {
      // Surfaces — match --surface-950 / --surface-900
      'editor.background': '#080C12',
      'editor.foreground': '#E6EAF2',
      'editorGutter.background': '#080C12',
      'minimap.background': '#0A0E15',
      // Lines & cursor
      'editorLineNumber.foreground': '#333F52',
      'editorLineNumber.activeForeground': '#8B95A7',
      'editorCursor.foreground': '#A78BFA',
      'editor.selectionBackground': '#7C3AED44',
      'editor.inactiveSelectionBackground': '#7C3AED22',
      'editor.lineHighlightBackground': '#FFFFFF07',
      'editor.lineHighlightBorder': '#00000000',
      'editor.wordHighlightBackground': '#7C3AED33',
      'editorBracketMatch.background': '#7C3AED2E',
      'editorBracketMatch.border': '#7C3AED66',
      // Indent guides / whitespace
      'editorIndentGuide.background1': '#161E2C',
      'editorIndentGuide.activeBackground1': '#2A3548',
      // Widgets (autocomplete, hover, find)
      'editorWidget.background': '#0D131C',
      'editorWidget.border': '#222D39',
      'editorSuggestWidget.background': '#0D131C',
      'editorSuggestWidget.border': '#222D39',
      'editorSuggestWidget.selectedBackground': '#7C3AED33',
      'editorHoverWidget.background': '#0D131C',
      'editorHoverWidget.border': '#222D39',
      'editor.findMatchBackground': '#7C3AED55',
      'editor.findMatchHighlightBackground': '#7C3AED30',
      // Scrollbars
      'scrollbarSlider.background': '#2A354266',
      'scrollbarSlider.hoverBackground': '#39465C88',
      'scrollbarSlider.activeBackground': '#46587AAA',
      // Diff editor
      'diffEditor.insertedTextBackground': '#22C55E1E',
      'diffEditor.removedTextBackground': '#EF44441E',
      'diffEditor.insertedLineBackground': '#22C55E10',
      'diffEditor.removedLineBackground': '#EF444410',
      'diffEditor.border': '#222D39',
      'diffEditor.diagonalFill': '#ffffff08',
      'diffEditor.unchangedRegionBackground': '#0A0E15',
      // Misc
      'editorOverviewRuler.border': '#00000000',
      'editorError.foreground': '#F87171',
      'editorWarning.foreground': '#FBBF24',
      'editorInfo.foreground': '#60A5FA',
    },
  });
}

/** Shared Monaco editor options tuned for the IDE layout. */
export const smEditorOptions = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: true, renderCharacters: false, maxColumn: 90 },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth' as const,
  cursorSmoothCaretAnimation: 'on' as const,
  padding: { top: 8, bottom: 8 },
  renderLineHighlight: 'all' as const,
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true, indentation: true },
  wordWrap: 'off' as const,
  tabSize: 2,
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },
  automaticLayout: true,
} as const;
