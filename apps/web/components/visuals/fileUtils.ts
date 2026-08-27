/**
 * Parsing helpers for the RDS File-Based + Project-Metadata blocks.
 *
 * Contract (prompts.py + RDS backend):
 *
 *   Project-Metadata-st
 *   Project Name: My App
 *   Language: JavaScript
 *   Framework: React
 *   Can Run with CDN: yes
 *   If CDN Yes, List CDNs:
 *   - https://cdn.tailwindcss.com
 *   Main Entry Point: index.html
 *   Dependencies:
 *   - react: ^18.2.0
 *   Install Command: npm install
 *   Run Command: npm start
 *   Project-Metadata-ed
 *
 *   File-Based-st
 *   Project: My App
 *   File: index.html
 *   ```html
 *   <h1>Hello</h1>
 *   ```
 *   File: style.css
 *   ```css
 *   h1 { color: #7C3AED; }
 *   ```
 *   File-Based-ed
 *
 * The file parser matches RDS (`File: name` + content up to the next
 * `File: `, a closing fence, or the end) and strips stray fences/separators.
 */

export interface FileEntry {
  filename: string;
  content: string;
  language: string;
}

export interface ProjectMetadata {
  projectName?: string;
  language?: string;
  framework?: string;
  canRunWithCDN?: boolean;
  cdns?: string[];
  mainEntryPoint?: string;
  dependencies?: Record<string, string>;
  installCommand?: string;
  runCommand?: string;
}

const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  cpp: 'cpp',
  cc: 'cpp',
  h: 'c',
  c: 'c',
  php: 'php',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  xml: 'xml',
  svg: 'svg',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  env: 'dotenv',
  gitignore: 'gitignore',
};

export function getFileLanguage(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  if (base === '.env') return 'dotenv';
  if (base === '.gitignore') return 'gitignore';
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_MAP[ext] ?? 'text';
}

/** Strip a stray opening fence (` ```lang`), closing fence and `---` separators. */
function cleanFileContent(content: string): string {
  return content
    .replace(/^\s*```[\w-]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .replace(/\n?---\s*$/, '')
    .trim();
}

/** Parse the files inside a (possibly still-streaming) File-Based block. */
export function parseFiles(content: string): FileEntry[] {
  const files: FileEntry[] = [];
  const re = /File: ([^\n]+)(?:\n([\s\S]*?))?(?=\nFile: |\n```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const filename = m[1].trim();
    if (!filename) continue;
    files.push({
      filename,
      content: cleanFileContent(m[2] ?? ''),
      language: getFileLanguage(filename),
    });
  }
  return files;
}

/** Extract the `Project: <name>` line that may open a File-Based block. */
export function extractProjectName(content: string): string | null {
  const m = content.match(/Project:\s*(.+?)(?:\n|$)/);
  return m ? m[1].trim() : null;
}

function normalizeJsonMetadata(j: Record<string, unknown>): ProjectMetadata {
  const run = (v: unknown) => (typeof v === 'string' ? /yes|true/i.test(v) : Boolean(v));
  return {
    projectName: (j.projectName as string) ?? (j['Project Name'] as string),
    language: (j.language as string) ?? (j['Language'] as string),
    framework: (j.framework as string) ?? (j['Framework'] as string),
    canRunWithCDN:
      (j.canRunWithCDN as boolean) ?? run(j['Can Run with CDN']),
    cdns: ((j.cdns as unknown) ?? (j.CDNs as unknown) ?? []) as string[],
    mainEntryPoint: (j.mainEntryPoint as string) ?? (j['Main Entry Point'] as string),
    dependencies: ((j.dependencies as unknown) ?? {}) as Record<string, string>,
    installCommand: (j.installCommand as string) ?? (j['Install Command'] as string),
    runCommand: (j.runCommand as string) ?? (j['Run Command'] as string),
  };
}

/** Parse a Project-Metadata block (RDS line format or JSON). */
export function parseProjectMetadata(content: string): ProjectMetadata | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeJsonMetadata(parsed as Record<string, unknown>);
    }
  } catch {
    /* not JSON — fall through to the line format */
  }

  const meta: ProjectMetadata = { cdns: [], dependencies: {} };
  let mode: 'cdns' | 'deps' | null = null;

  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('-')) {
      if (mode === 'cdns') meta.cdns!.push(line.slice(1).trim());
      else if (mode === 'deps') {
        const sep = line.slice(1).split(':');
        const key = sep.shift()?.trim();
        if (key) meta.dependencies![key] = sep.join(':').trim() || '*';
      }
      continue;
    }

    mode = null;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) continue;

    switch (key) {
      case 'Project Name':
        meta.projectName = value;
        break;
      case 'Language':
        meta.language = value;
        break;
      case 'Framework':
        meta.framework = value;
        break;
      case 'Can Run with CDN':
        meta.canRunWithCDN = /yes|true/i.test(value);
        break;
      case 'If CDN Yes, List CDNs':
        mode = 'cdns';
        break;
      case 'Main Entry Point':
        meta.mainEntryPoint = value;
        break;
      case 'Dependencies':
        mode = 'deps';
        break;
      case 'Install Command':
        meta.installCommand = value;
        break;
      case 'Run Command':
        meta.runCommand = value;
        break;
    }
  }

  if (!meta.projectName && !meta.language && !meta.framework && !meta.mainEntryPoint) {
    return null;
  }
  return meta;
}
