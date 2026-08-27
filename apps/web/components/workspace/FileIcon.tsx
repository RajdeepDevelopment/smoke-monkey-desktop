'use client';

import { memo } from 'react';

/**
 * Seti/VS Code-style file type icons. Compact inline SVGs so the tree stays
 * crisp at 14px without pulling an icon font. Letters are rendered in the
 * monospace stack to look like a developer tool, not a web dashboard.
 */

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function LetterIcon({ label, color, bg }: { label: string; color: string; bg?: string }) {
  const fontSize = label.length >= 4 ? 6.5 : label.length === 3 ? 7.5 : label.length === 2 ? 8.5 : 10;
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      {bg && <rect x="0.5" y="0.5" width="15" height="15" rx="3" fill={bg} />}
      <text
        x="8"
        y="11.2"
        textAnchor="middle"
        fontFamily={MONO}
        fontWeight={700}
        fontSize={fontSize}
        fill={color}
      >
        {label}
      </text>
    </svg>
  );
}

function ReactIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke={color} strokeWidth="0.9" aria-hidden>
      <circle cx="8" cy="8" r="1.4" fill={color} stroke="none" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.6" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.5" ry="2.6" transform="rotate(120 8 8)" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="#A074C4" strokeWidth="1.1" />
      <circle cx="5.2" cy="6" r="1.2" fill="#A074C4" />
      <path d="M2.5 12 L6.5 8.5 L9 10.5 L11.5 8 L13.5 10 L13.5 12 Z" fill="#A074C4" opacity="0.75" />
    </svg>
  );
}

function ZipIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <rect x="2.5" y="2" width="11" height="12" rx="1.5" fill="none" stroke="#E8B36B" strokeWidth="1.1" />
      <path d="M8 2v12M8 3.5h1.5M8 5.5H6.5M8 7.5h1.5M8 9.5H6.5" stroke="#E8B36B" strokeWidth="1" />
    </svg>
  );
}

function LockIcon({ color = '#C792EA' }: { color?: string }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill={color} opacity="0.85" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke={color} strokeWidth="1.3" fill="none" />
    </svg>
  );
}

function GitFileIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <path d="M13.5 7.3 8.7 2.5a1 1 0 0 0-1.4 0L2.5 7.3a1 1 0 0 0 0 1.4l4.8 4.8a1 1 0 0 0 1.4 0l4.8-4.8a1 1 0 0 0 0-1.4Z" fill="#F0533D" opacity="0.9" />
      <circle cx="8" cy="5.6" r="1" fill="#0B0F17" />
      <circle cx="8" cy="10.4" r="1" fill="#0B0F17" />
      <circle cx="5.6" cy="8" r="1" fill="#0B0F17" />
      <path d="M8 6.4v3.2M7.2 8h-1" stroke="#0B0F17" strokeWidth="0.9" />
    </svg>
  );
}

function DockerIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <rect x="3" y="8.5" width="2.2" height="2.2" fill="#519ABA" />
      <rect x="5.6" y="8.5" width="2.2" height="2.2" fill="#519ABA" />
      <rect x="8.2" y="8.5" width="2.2" height="2.2" fill="#519ABA" />
      <rect x="5.6" y="5.9" width="2.2" height="2.2" fill="#519ABA" />
      <rect x="8.2" y="5.9" width="2.2" height="2.2" fill="#519ABA" />
      <path d="M2 11.5c1.2 2.2 3.6 3 5.9 3 3.6 0 5.9-1.9 6.4-5.3.8.3 1.6.1 2-.4-.5-.7-1.3-.9-2-.7" stroke="#519ABA" strokeWidth="0.9" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function MarkdownIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <rect x="0.5" y="2.5" width="15" height="11" rx="2" fill="none" stroke="#519ABA" strokeWidth="1.1" />
      <path d="M3 10.5V5.5l2 2.5 2-2.5v5" stroke="#519ABA" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
      <path d="M11 5.5v4m0 0-1.6-1.6M11 9.5l1.6-1.6" stroke="#519ABA" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function DefaultFileIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="#6B7689" strokeWidth="1.1" aria-hidden>
      <path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.5L9.5 1.5Z" />
      <path d="M9.5 1.5v4h4" />
    </svg>
  );
}

function iconFor(name: string): JSX.Element | null {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';

  // Special full names first
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower === 'docker-compose.yml' || lower === 'docker-compose.yaml' || lower.startsWith('docker-compose.')) return <DockerIcon />;
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules' || lower === '.gitkeep') return <GitFileIcon />;
  if (lower.startsWith('.env')) return <LockIcon />;
  if (lower === 'license' || lower === 'license.md' || lower === 'license.txt') return <LetterIcon label="§" color="#8B95A7" />;
  if (/^package(-lock)?\.(json|yaml)$/.test(lower)) return <LetterIcon label="pkg" color="#CB3837" />;
  if (lower.startsWith('tsconfig')) return <LetterIcon label="TS" color="#FFFFFF" bg="#3178C6" />;

  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return <LetterIcon label="TS" color="#FFFFFF" bg="#3178C6" />;
    case 'js':
    case 'mjs':
    case 'cjs':
      return <LetterIcon label="JS" color="#0B0F17" bg="#F0DB4F" />;
    case 'tsx':
      return <ReactIcon color="#41C4DD" />;
    case 'jsx':
      return <ReactIcon color="#61DAFB" />;
    case 'json':
    case 'jsonc':
    case 'json5':
      return <LetterIcon label="{ }" color="#CBCB41" />;
    case 'md':
    case 'mdx':
      return <MarkdownIcon />;
    case 'css':
      return <LetterIcon label="CSS" color="#42A5F5" />;
    case 'scss':
    case 'sass':
      return <LetterIcon label="SCSS" color="#CF649A" />;
    case 'less':
      return <LetterIcon label="LESS" color="#2B5E8E" />;
    case 'html':
    case 'htm':
      return <LetterIcon label="<>" color="#E44D26" />;
    case 'py':
      return <LetterIcon label="PY" color="#3572A5" />;
    case 'rs':
      return <LetterIcon label="RS" color="#DEA584" />;
    case 'go':
      return <LetterIcon label="GO" color="#00ADD8" />;
    case 'java':
      return <LetterIcon label="J" color="#B07219" />;
    case 'kt':
    case 'kts':
      return <LetterIcon label="KT" color="#A97BFF" />;
    case 'swift':
      return <LetterIcon label="SW" color="#F05138" />;
    case 'c':
    case 'h':
      return <LetterIcon label="C" color="#5E97D0" />;
    case 'cpp':
    case 'hpp':
    case 'cc':
      return <LetterIcon label="C++" color="#F34B7D" />;
    case 'cs':
      return <LetterIcon label="C#" color="#68217A" />;
    case 'php':
      return <LetterIcon label="PHP" color="#A072C7" />;
    case 'rb':
      return <LetterIcon label="RB" color="#CC342D" />;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return <LetterIcon label=">_" color="#89E051" />;
    case 'ps1':
      return <LetterIcon label=">_" color="#5391FE" />;
    case 'sql':
      return <LetterIcon label="SQL" color="#DD8A3C" />;
    case 'yml':
    case 'yaml':
      return <LetterIcon label="Y" color="#CB171E" />;
    case 'toml':
      return <LetterIcon label="T" color="#9C8A63" />;
    case 'xml':
      return <LetterIcon label="<>" color="#87BA47" />;
    case 'svg':
      return <ImageIcon />;
    case 'vue':
      return <LetterIcon label="V" color="#41B883" />;
    case 'svelte':
      return <LetterIcon label="S" color="#FF3E00" />;
    case 'graphql':
    case 'gql':
      return <LetterIcon label="◆" color="#E535AB" />;
    case 'proto':
      return <LetterIcon label="P" color="#4B8BBE" />;
    case 'lua':
      return <LetterIcon label="LUA" color="#000080" />;
    case 'dart':
      return <LetterIcon label="DT" color="#00B4AB" />;
    case 'ex':
    case 'exs':
      return <LetterIcon label="EX" color="#6E5A8E" />;
    case 'hs':
      return <LetterIcon label="HS" color="#5E5086" />;
    case 'clj':
    case 'cljs':
      return <LetterIcon label="CL" color="#63B132" />;
    case 'r':
      return <LetterIcon label="R" color="#276DC3" />;
    case 'pdf':
      return <LetterIcon label="PDF" color="#F87171" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'ico':
      return <ImageIcon />;
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'avi':
    case 'mkv':
      return <LetterIcon label="▶" color="#A074C4" />;
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'ogg':
      return <LetterIcon label="♫" color="#A074C4" />;
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
    case '7z':
    case 'bz2':
      return <ZipIcon />;
    case 'lock':
      return <LockIcon color="#8B95A7" />;
    case 'ttf':
    case 'otf':
    case 'woff':
    case 'woff2':
      return <LetterIcon label="A" color="#8FB8F5" />;
    default:
      return null;
  }
}

export const FileIcon = memo(function FileIcon({ name }: { name: string }) {
  return iconFor(name) ?? <DefaultFileIcon />;
});
