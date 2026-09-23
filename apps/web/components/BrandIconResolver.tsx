'use client';

import { ExternalLink, Plug, Zap } from 'lucide-react';
import type { IconType } from 'react-icons';
import { cn } from '../lib/utils';

/**
 * A curated brand-icon registry (react-icons 'si'/'fa' packs, 300+ icons) that
 * maps provider/model names → an official brand icon + accent tone via regex
 * matching. `resolveBrand(name)` lower-cases the input and walks an ordered
 * list of matchers; the first match wins.
 */

// Ordered matchers: [regex, icon, brand accent class] (more specific first).
type Matcher = [RegExp, IconType, string];

import {
  SiAnthropic,
  SiGoogle,
  SiGooglegemini,
  SiGooglecloud,
  SiOpenrouter,
  SiMeta,
  SiHuggingface,
  SiPerplexity,
SiDeepseek,
  SiOpencode,
  SiCloudflare,
  SiVercel,
  SiNetlify,
  SiSupabase,
  SiFirebase,
  SiMongodb,
  SiRedis,
  SiPostgresql,
  SiMysql,
  SiSqlite,
  SiDocker,
  SiKubernetes,
  SiPrometheus,
  SiGrafana,
  SiDatadog,
  SiNewrelic,
  SiSentry,
  SiElasticcloud,
  SiJira,
  SiNotion,
  SiLinear,
  SiFigma,
  SiDiscord,
  SiTelegram,
  SiWhatsapp,
  SiStripe,
  SiPaypal,
  SiAlgolia,
  SiQdrant,
  SiMilvus,
SiLangchain,
  SiMoonshotai,
  SiQwen,
  SiMinimax,
  SiApache,
  SiNginx,
  SiPython,
  SiTypescript,
  SiNextdotjs,
  SiRust,
  SiGo,
  SiTailwindcss,
  SiVite,
  SiWebpack,
  SiMistralai,
  SiApachekafka,
  SiAnsible,
  SiTerraform,
  SiNvidia,
  SiBrave,
  SiDuckduckgo,
  SiX,
  SiObsidian,
  SiMiro,
  SiLucid,
  SiExcalidraw,
  SiMermaid,
  SiUml,
  SiDiagramsdotnet,
  SiGitlab,
  SiRender,
  SiRailway,
  SiFlydotio,
  SiGooglebigquery,
  SiGit,
} from 'react-icons/si';
import {
  FaGithub,
  FaSlack,
  FaAws,
  FaMicrosoft,
  FaNode,
  FaDocker,
  FaLinux,
  FaApple,
  FaWindows,
  FaDatabase,
} from 'react-icons/fa';

/**
 * Official Apify spider-in-hexagon brand mark (orange #F9AA25).
 * Monochrome SVG that inherits `currentColor` so Tailwind text-* classes work.
 */
export function ApifyIcon({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} {...props} aria-hidden="true">
      {/* Hexagon shell */}
      <path
        d="M12 1.5L21.7 7.1v11L12 22.7 2.3 18.1v-11L12 1.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* Spider body */}
      <circle cx="12" cy="13.5" r="2.5" fill="currentColor" />
      {/* Spider legs (4 pairs) */}
      <path
        d="M9.8 11.5 6 7.5m7.7-.3-1.8-5.2m-0.2 5.1 6-3.4m-6.3 3.1 6 3.1m-7.5-5.9-3.8 4.3m7.5-0.3-3.7-4.2m7.7.3-1.5-5.2m-0.5 5.2 5.5-3"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Monogram tile for AI brands that have no official simple-icon (GLM, Kimi
 * sister models, Smoke Monkey's own keyless lineup, …). Renders the brand's
 * first letter in its accent color on a dark tile, mirroring NVIDIA's `n`.
 */
function letterGlyph(letter: string): IconType {
  function BrandLetter({ className }: { className?: string }) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center rounded-[4px] bg-surface-700/60 text-[10px] font-extrabold leading-none',
          className,
        )}
      >
        {letter}
      </span>
    );
  }
  return BrandLetter as unknown as IconType;
}

/** True when a name refers to the Apify MCP server / preset. */
export function isApify(name: string): boolean {
  return /apify|actors-mcp/i.test(name);
}

/**
 * Official OpenAI/ChatGPT hexagon mark. Monochrome SVG that inherits
 * `currentColor` so Tailwind text-* classes work.
 */
export function OpenAIKnotIcon({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} {...props} aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0-.511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export const BRAND_MATCHERS: Matcher[] = [
  // ── MCP servers (by known server name) ──
  [/apify|actors-mcp/, ApifyIcon as unknown as IconType, 'text-[#F9AA25]'],
  [/playwright/, Plug, 'text-[#FB542B]'],
  [/puppeteer|browser-use/, Plug, 'text-[#FFD54F]'],
  [/memory|memory-mcp|knowledge.graph|zep/, Plug, 'text-[#FBBF24]'],
  [/firecrawl/, Plug, 'text-[#FF6B35]'],
  [/tavily|exa-mcp/, Plug, 'text-[#22D3EE]'],
  [/server-sqlite|sqlite/, SiSqlite, 'text-[#003B57]'],
  [/google-drive|gdrive/, SiGoogle, 'text-[#4285F4]'],
  [/sequential-thinking|obsidian|thinking/, SiObsidian, 'text-[#7C3AED]'],
  [/filesystem|server-filesystem/, Plug, 'text-emerald-300'],
  [/^git(\b|-mcp|$)/, SiGit, 'text-[#F05133]'],
  [/teams-mcp|\bteams\b/, FaMicrosoft, 'text-[#6264A7]'],

  // ── MCP: whiteboards & flowcharts ──
  [/miro/, SiMiro, 'text-[#FFD02F]'],
  [/lucidchart|lucid\.app|lucid/, SiLucid, 'text-[#A9792B]'],
  [/excalidraw/, SiExcalidraw, 'text-[#8965CA]'],
  [/mermaid/, SiMermaid, 'text-[#FF3670]'],
  [/plantuml/, SiUml, 'text-[#00C7B6]'],
  [/drawio|draw\.io|diagrams\.net/, SiDiagramsdotnet, 'text-[#F08705]'],

  // ── MCP: web / code / hosting ──
  [/mcp-server-fetch|fetch-browser|fetch$/, Plug, 'text-cyan-300'],
  [/gitlab/, SiGitlab, 'text-[#FC6D26]'],
  [/render/, SiRender, 'text-[#FF6A4D]'],
  [/railway/, SiRailway, 'text-[#9D7CEB]'],
  [/fly\.io|flyio|fly-mcp/, SiFlydotio, 'text-[#A21CAF]'],
  [/bigquery/, SiGooglebigquery, 'text-[#4285F4]'],
  [/sqladmin|cloudsql|cloud-sql|cloud sql/, SiGooglecloud, 'text-[#4285F4]'],

  // ── AI model providers ──
  [/anthropic|claude|fable/, SiAnthropic, 'text-[#D97757]'],
  [/openrouter/, SiOpenrouter, 'text-[#FF6B1A]'],
  [/mistral/, SiMistralai, 'text-[#FF7000]'],
  [/meta|llama/, SiMeta, 'text-[#0668E1]'],
  [/hugg?ingface/, SiHuggingface, 'text-[#FFD21E]'],
  [/perplexity/, SiPerplexity, 'text-[#20C8FF]'],
  [/deepseek/, SiDeepseek, 'text-[#4D6BFE]'],
  [/gemini|vertex|aistudio/, SiGooglegemini, 'text-[#4285F4]'],
  [/google|palm|gemma/, SiGoogle, 'text-[#4285F4]'],
  [/nvidia|nemotron|nim$/, SiNvidia, 'text-[#76B900]'],
  [/xai|grok\b/, SiX, 'text-white'],
  [/openai|chatgpt\b|\bgpt|\bo\d|davinci/, OpenAIKnotIcon as unknown as IconType, 'text-[#10A37F]'],
  [/askai/, OpenAIKnotIcon as unknown as IconType, 'text-[#10A37F]'],
  [/opencode|zen\b/, SiOpencode, 'text-white'],
  [/qwen/, SiQwen, 'text-[#5E5CE6]'],
  [/kimi|moonshot/, SiMoonshotai, 'text-[#5B8DEF]'],
  [/minimax/, SiMinimax, 'text-white'],
  [/muse\b/, letterGlyph('M'), 'text-[#F472B6]'],
  [/laguna/, letterGlyph('L'), 'text-[#22D3EE]'],
  [/mimo\b/, letterGlyph('M'), 'text-[#FBBF24]'],
  [/hy3|hy\b/, letterGlyph('H'), 'text-[#A3E635]'],
  [/ling\b/, letterGlyph('L'), 'text-[#F87171]'],
  [/auto([/.-]|$)/, Zap, 'text-[#8B5CF6]'],
  [/\bomni(?:route)?\b/, Zap, 'text-[#8B5CF6]'],
  [/big-pickle|smoke.?monkey/, letterGlyph('S'), 'text-[#818CF8]'],
  [/glm|zhipu|chatglm/, letterGlyph('G'), 'text-[#7C3AED]'],
  [/cohere/, Plug, 'text-[#39594D]'],
  [/groq/, Plug, 'text-[#F55036]'],
  [/lmstudio/, Plug, 'text-[#00B7C3]'],
  [/ollama|llama/, SiMeta, 'text-[#0668E1]'],
  [/localai/, Plug, 'text-sky-400'],

  // ── Web search ──
  [/brave/, SiBrave, 'text-[#FB542B]'],
  [/duckduckgo|ddg/, SiDuckduckgo, 'text-[#DE5833]'],
  [/tavily/, Plug, 'text-[#4E67C3]'],
  [/bing/, FaMicrosoft, 'text-[#008373]'],
  [/serper|exa$/, Plug, 'text-[#22D3EE]'],

  // ── Cloud / hosting / infra ──
  [/aws|amazon|bedrock|sagemaker/, FaAws, 'text-[#FF9900]'],
  [/azure|microsoft|openai/, FaMicrosoft, 'text-[#0078D4]'],
  [/gcp|google cloud/, SiGooglecloud, 'text-[#4285F4]'],
  [/cloudflare|workers/, SiCloudflare, 'text-[#F38020]'],
  [/vercel/, SiVercel, 'text-white'],
  [/netlify/, SiNetlify, 'text-[#00C7B7]'],
  [/supabase/, SiSupabase, 'text-[#3ECF8E]'],
  [/firebase/, SiFirebase, 'text-[#FFCA28]'],
  [/digitalocean/, SiGoogle, 'text-[#0080FF]'],
  [/heroku/, Plug, 'text-[#430098]'],

  // ── Databases & storage ──
  [/mongodb|mongo|atlas/, SiMongodb, 'text-[#47A248]'],
  [/redis|upstash/, SiRedis, 'text-[#DC382D]'],
  [/postgres|postgre|supabase/, SiPostgresql, 'text-[#4169E1]'],
  [/mysql|mariadb/, SiMysql, 'text-[#4479A1]'],
  [/sqlite/, SiSqlite, 'text-[#003B57]'],
  [/elastic/, SiElasticcloud, 'text-[#005571]'],
  [/qdrant/, SiQdrant, 'text-[#FF355D]'],
  [/milvus/, SiMilvus, 'text-[#00A1EA]'],
  [/pinecone/, Plug, 'text-[#8B5CF6]'],
  [/faiss|weaviate|chroma/, Plug, 'text-violet-400'],
  [/dataset|data|db|sql/, FaDatabase, 'text-ink-muted'],

  // ── Dev / CI / observability ──
  [/github|gitlab|gitea|bitbucket/, FaGithub, 'text-white'],
  [/sentry/, SiSentry, 'text-[#8C54FF]'],
  [/newrelic|new relic/, SiNewrelic, 'text-[#008C99]'],
  [/datadog/, SiDatadog, 'text-[#632CA6]'],
  [/grafana/, SiGrafana, 'text-[#F46800]'],
  [/prometheus/, SiPrometheus, 'text-[#E6522C]'],
  [/docker|container/, FaDocker, 'text-[#2496ED]'],
  [/kubernetes|k8s/, SiKubernetes, 'text-[#326CE5]'],
  [/jira|atlassian|confluence/, SiJira, 'text-[#0052CC]'],
  [/slack/, FaSlack, 'text-[#E01E5A]'],
  [/notion/, SiNotion, 'text-white'],
  [/linear/, SiLinear, 'text-[#5E6AD2]'],
  [/figma/, SiFigma, 'text-[#F24E1E]'],
  [/nginx/, SiNginx, 'text-[#009639]'],
  [/apache/, SiApache, 'text-[#D22128]'],
  [/kafka/, SiApachekafka, 'text-white'],
  [/ansible/, SiAnsible, 'text-[#EE0000]'],
  [/terraform/, SiTerraform, 'text-[#7B42BC]'],

  // ── Languages / frameworks ──
  [/python/, SiPython, 'text-[#3776AB]'],
  [/typescript|ts-/, SiTypescript, 'text-[#3178C6]'],
  [/javascript|node/, FaNode, 'text-[#339933]'],
  [/react|next/, SiNextdotjs, 'text-white'],
  [/rust/, SiRust, 'text-[#CE422B]'],
  [/golang|\bgo\b/, SiGo, 'text-[#00ADD8]'],
  [/tailwind/, SiTailwindcss, 'text-[#38BDF8]'],
  [/vite/, SiVite, 'text-[#646CFF]'],
  [/webpack/, SiWebpack, 'text-[#8DD6F9]'],

  // ── OS / misc ──
  [/linux|ubuntu|debian|fedora/, FaLinux, 'text-[#FCC624]'],
  [/apple|mac|ios/, FaApple, 'text-white'],
  [/windows/, FaWindows, 'text-[#0078D6]'],
  [/discord/, SiDiscord, 'text-[#5865F2]'],
  [/telegram/, SiTelegram, 'text-[#26A5E4]'],
  [/whatsapp/, SiWhatsapp, 'text-[#25D366]'],
  [/stripe/, SiStripe, 'text-[#635BFF]'],
  [/paypal/, SiPaypal, 'text-[#00457C]'],
  [/algolia/, SiAlgolia, 'text-[#5468FF]'],
  [/langchain|langgraph/, SiLangchain, 'text-[#1C3C3C]'],

  // ── MCP fallback (last): any remaining MCP server name gets a neutral plug. ──
  [/@modelcontextprotocol|modelcontextprotocol|server-|_mcp|.mcp/, Plug, 'text-sky-400'],
];

export function resolveBrand(name: string): { Icon: IconType; color: string } {
  const lower = name.toLowerCase();
  for (const [re, Icon, color] of BRAND_MATCHERS) {
    if (re.test(lower)) return { Icon, color };
  }
  return { Icon: Plug, color: 'text-ink-muted' };
}

/**
 * Regex-resolves the brand icon + accent for a model id (e.g. an OmniRoute
 * key like `chatgpt-4.0`, `gemini-3.7-flash`, `claude-opus-4`). Returns null
 * when no brand matched, so callers can fall back to a provider glyph.
 */
export function modelBrandIcon(name: string): { Icon: IconType; color: string } | null {
  const b = resolveBrand(name);
  return b.Icon === Plug && b.color === 'text-ink-muted' ? null : b;
}

/**
 * Resolves the icon to render for a configured MCP server. An explicit
 * `customIcon` (brand hint like "github", or a single emoji) wins; otherwise
 * falls back to `resolveBrand(name)`.
 */
export function resolveServerIcon(
  name: string,
  customIcon?: string | null,
): { Icon: IconType; color: string; glyph: string | null } {
  const raw = (customIcon ?? '').trim();
  if (raw) {
    const exactLower = raw.toLowerCase();
    for (const [re, Icon, color] of BRAND_MATCHERS) {
      if (re.test(exactLower) && !(Icon === Plug && color === 'text-ink-muted')) {
        return { Icon, color, glyph: null };
      }
    }
    const cp = Array.from(raw);
    if (cp.length >= 1 && cp.length <= 2 && /[\p{Emoji}]/u.test(raw)) {
      return { Icon: Plug, color: 'text-white', glyph: raw };
    }
  }
  const b = resolveBrand(name);
  return { Icon: b.Icon, color: b.color, glyph: null };
}

/**
 * Resolves the site brand icon for an external URL's hostname (e.g. a
 * `https://miro.com/app/...` board link → SiMiro). Returns null when the host
 * is unknown, so callers can fall back to a generic external-link glyph.
 */
export function faviconForUrl(href: string | undefined | null): { Icon: IconType; color: string } | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    const brand = resolveBrand(new URL(href).hostname);
    if (brand.Icon === Plug && brand.color === 'text-ink-muted') return null;
    return brand;
  } catch {
    return null;
  }
}

/** Renders an official brand icon for a provider/model string (fallback: Plug). */
export function BrandIconFor({
  name,
  className,
  containerClassName,
  size = 'md',
}: {
  name: string;
  className?: string;
  containerClassName?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { Icon, color } = resolveBrand(name);
  const apify = isApify(name);
  const box =
    apify
      ? size === 'sm'
        ? 'h-7 w-7 rounded-full'
        : size === 'lg'
          ? 'h-11 w-11 rounded-full'
          : 'h-9 w-9 rounded-full'
      : size === 'sm'
        ? 'h-6 w-6 rounded-md'
        : size === 'lg'
          ? 'h-10 w-10 rounded-xl'
          : 'h-8 w-8 rounded-lg';
  return (
    <span
      className={cn(
        apify
          ? 'flex shrink-0 items-center justify-center'
          : 'flex shrink-0 items-center justify-center bg-surface-700',
        box,
        containerClassName,
      )}
    >
      <Icon
        className={cn(
          apify
            ? size === 'sm'
              ? 'h-5 w-5'
              : size === 'lg'
                ? 'h-8 w-8'
                : 'h-6 w-6'
            : size === 'sm' ? 'h-3.5 w-3.5' : size === 'lg' ? 'h-5 w-5' : 'h-4 w-4',
          color,
          apify && 'drop-shadow-[0_0_8px_rgba(249,170,37,0.65)]',
          className,
        )}
      />
    </span>
  );
}
