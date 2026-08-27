/** Centralized file-type registry: one place decides how a path is presented.
 *  No component should guess extensions on its own. */

export type FileViewerType =
  | 'code'      // Monaco with language mode
  | 'markdown'  // Monaco source ⇄ rendered preview
  | 'image'     // Image viewer (zoom / fit / rotate)
  | 'svg'       // SVG preview ⇄ source
  | 'pdf'       // Embedded PDF viewer
  | 'csv'       // Table viewer
  | 'text'      // Plain text in Monaco
  | 'binary';   // Info card, never rendered as text

const CODE_LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', vue: 'html', svelte: 'html',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', kt: 'kotlin',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  lua: 'lua', pl: 'perl', r: 'r', dart: 'dart', ex: 'elixir', exs: 'elixir',
  scala: 'scala', hs: 'haskell', clj: 'clojure', proto: 'proto',
};

/** Extension-less files that are still editable text/code (VS Code style). */
const SPECIAL_TEXT_FILES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  procfile: 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  justfile: 'shell',
};

const TEXT_EXTRAS = new Set([
  'txt', 'log', 'env', 'gitignore', 'gitattributes', 'editorconfig', 'npmrc',
  'nvmrc', 'babelrc', 'eslintrc', 'prettierrc', 'lock', 'cfg', 'properties',
  'mdx', 'rst', 'adoc', 'patch', 'diff', 'srt',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const BINARY_HINTS = new Set([
  'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'bin', 'dat', 'class',
  'jar', 'war', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'ogg',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'ai', 'sketch', 'wasm',
  'db', 'sqlite', 'sqlite3', 'pyc', 'pyo', 'node', 'pack', 'idx',
]);

export function getFileViewerType(path: string): FileViewerType {
  const name = path.split('/').pop() || path;
  const lowerName = name.toLowerCase();
  const ext = lowerName.includes('.') ? lowerName.split('.').pop()! : '';

  // .env variants: ".env", ".env.local", "production.env"
  if (ext === 'env' || lowerName.startsWith('.env')) return 'code';

  switch (ext) {
    case 'md': case 'markdown': return 'markdown';
    case 'svg': return 'svg';
    case 'pdf': return 'pdf';
    case 'csv': case 'tsv': return 'csv';
    default: break;
  }

  if (IMAGE_EXTS.has(ext)) return 'image';
  if (BINARY_HINTS.has(ext)) return 'binary';
  if (!ext && SPECIAL_TEXT_FILES[lowerName]) return 'code';
  if (CODE_LANG_BY_EXT[ext] !== undefined) return 'code';
  if (TEXT_EXTRAS.has(ext) || !ext) return 'text';
  return 'binary';
}

export function getLanguageFromPath(path: string): string {
  const name = path.split('/').pop() || path;
  const lowerName = name.toLowerCase();
  const ext = lowerName.includes('.') ? lowerName.split('.').pop()! : '';
  if (!ext && SPECIAL_TEXT_FILES[lowerName]) return SPECIAL_TEXT_FILES[lowerName];
  return CODE_LANG_BY_EXT[ext] ?? 'plaintext';
}

export function isEditableViewer(t: FileViewerType): boolean {
  return t === 'code' || t === 'markdown' || t === 'text' || t === 'svg';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
