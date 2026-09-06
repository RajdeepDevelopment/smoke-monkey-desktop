'use client';

import { Plug } from 'lucide-react';
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

/** True when a name refers to the Apify MCP server / preset. */
export function isApify(name: string): boolean {
  return /apify|actors-mcp/i.test(name);
}

export const BRAND_MATCHERS: Matcher[] = [
  // ── MCP servers (by known server name) ──
  [/apify|actors-mcp/, ApifyIcon as unknown as IconType, 'text-[#F9AA25]'],
  [/playwright/, Plug, 'text-[#FB542B]'],
  [/memory-mcp|knowledge.graph/, Plug, 'text-[#FBBF24]'],
  [/firecrawl/, Plug, 'text-[#FF6B35]'],
  [/tavily|exa-mcp/, Plug, 'text-[#22D3EE]'],
  [/server-sqlite|sqlite/, SiSqlite, 'text-[#003B57]'],

  // ── AI model providers ──
  [/anthropic|claude/, SiAnthropic, 'text-[#D97757]'],
  [/openrouter/, SiOpenrouter, 'text-[#FF6B1A]'],
  [/mistral/, SiMistralai, 'text-[#FF7000]'],
  [/meta|llama/, SiMeta, 'text-[#0668E1]'],
  [/hugg?ingface/, SiHuggingface, 'text-[#FFD21E]'],
  [/perplexity/, SiPerplexity, 'text-[#20C8FF]'],
  [/deepseek/, SiDeepseek, 'text-[#4D6BFE]'],
  [/gemini|vertex|aistudio/, SiGooglegemini, 'text-[#4285F4]'],
  [/google|palm/, SiGoogle, 'text-[#4285F4]'],
  [/nvidia|nemotron|nim$/, SiNvidia, 'text-[#76B900]'],
  [/xai|grok$/, SiX, 'text-white'],
  [/openai|chatgpt\b|\bgpt|\bo1|\bo3|davinci/, Plug, 'text-emerald-400'],
  [/askai|\bgpt/, Plug, 'text-emerald-400'],
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
];

export function resolveBrand(name: string): { Icon: IconType; color: string } {
  const lower = name.toLowerCase();
  for (const [re, Icon, color] of BRAND_MATCHERS) {
    if (re.test(lower)) return { Icon, color };
  }
  return { Icon: Plug, color: 'text-ink-muted' };
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
