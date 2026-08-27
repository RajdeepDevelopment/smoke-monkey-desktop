'use client';

import { useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount, OnChange } from '@monaco-editor/react';
import { SM_THEME, defineSmokeMonkeyTheme, smEditorOptions } from '../../lib/monaco-theme';

interface Props {
  filePath: string;
  content: string;
  language?: string;
  readOnly?: boolean;
  gotoLine?: number;
  onSave?: (path: string, content: string) => void;
  onContentChange?: (path: string, content: string) => void;
  className?: string;
}

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
    dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql',
    xml: 'xml', c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp',
    php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
    r: 'r', lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir',
    hs: 'haskell', ml: 'ocaml', clj: 'clojure',
    svg: 'xml', vue: 'html', svelte: 'html', ps1: 'powershell',
  };
  return map[ext] || 'plaintext';
}

export function MonacoCodeEditor({
  filePath,
  content,
  language,
  readOnly = false,
  gotoLine,
  onSave,
  onContentChange,
  className,
}: Props) {
  const editorRef = useRef<any>(null);
  const saveRef = useRef({ onSave, filePath, readOnly });

  // Keep latest save handler without re-binding the keybinding
  useEffect(() => {
    saveRef.current = { onSave, filePath, readOnly };
  }, [onSave, filePath, readOnly]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    // Cmd/Ctrl+S
    editor.addCommand(2048 | 49, () => {
      const { onSave: save, readOnly: ro } = saveRef.current;
      if (save && !ro) save(saveRef.current.filePath, editor.getValue());
    });
    editor.focus();
  }, []);

  const handleChange: OnChange = useCallback((value) => {
    onContentChange?.(filePath, value || '');
  }, [filePath, onContentChange]);

  // Jump to line (used by search results / go-to-line)
  useEffect(() => {
    if (!editorRef.current || !gotoLine || gotoLine < 1) return;
    const editor = editorRef.current;
    try {
      editor.revealLineInCenter(gotoLine);
      editor.setPosition({ lineNumber: gotoLine, column: 1 });
      editor.focus();
    } catch { /* model not ready */ }
  }, [gotoLine, filePath]);

  return (
    <div className={className ?? 'h-full'}>
      <Editor
        key={filePath}
        language={language || detectLanguage(filePath)}
        value={content}
        onChange={handleChange}
        onMount={handleEditorMount}
        beforeMount={defineSmokeMonkeyTheme}
        theme={SM_THEME}
        loading={
          <div className="flex h-full items-center justify-center text-xs text-ink-muted">
            Loading editor…
          </div>
        }
        options={{
          ...smEditorOptions,
          readOnly,
        }}
      />
    </div>
  );
}
