'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plug,
  Plus,
  Trash2,
  Power,
  PowerOff,
  Loader2,
  AlertTriangle,
  Check,
  X,
  Terminal,
  FileText,
  Globe,
  Code2,
  Database,
  Activity,
  MessageSquare,
  BrainCircuit,
  Brain,
  Network,
  Workflow,
  Cloud,
  Server,
  Plane,
  type LucideIcon,
} from 'lucide-react';
import {
  FaSlack,
  FaGithub,
  FaGitlab,
  FaDocker,
  FaFire,
  FaGlobe,
  FaAws,
  FaMicrosoft,
} from 'react-icons/fa';
import {
  SiPostgresql,
  SiMongodb,
  SiRedis,
  SiNotion,
  SiJira,
  SiLinear,
  SiSentry,
  SiNewrelic,
  SiQdrant,
  SiSqlite,
  SiBrave,
  SiIfttt,
  SiMiro,
  SiLucid,
  SiExcalidraw,
  SiMermaid,
  SiCloudflare,
  SiRender,
  SiVercel,
  SiSupabase,
  SiNetlify,
  SiRailway,
  SiGooglecloud,
} from 'react-icons/si';
import type { IconType } from 'react-icons';
import { ApifyIcon, isApify } from '../../components/BrandIconResolver';
import { api } from '../../lib/api';
import { openExternalUrl } from '../../lib/external-links';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toast';
import { cn } from '../../lib/utils';

interface McpServer {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  oauthConnected?: boolean;
  oauthExpiresAt?: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Preset {
  label: string;
  name: string;
  description: string;
  transport?: 'stdio' | 'http';
  command: string;
  args: string[];
  envKeys: string[];
  url?: string;
  keyGetUrl?: string;
  keyGetLabel?: string;
  dependency: string;
  /** Marks a remote host + OAuth-managed MCP server (special connect flow). */
  remote?: boolean;
  /** Remote server that needs a manually pre-registered OAuth client. */
  manualOAuth?: boolean;
  /** OAuth scopes to request (override discovery) for manual-OAuth servers. */
  oauthScopes?: string;
}

interface PresetCategory {
  label: string;
  icon: LucideIcon;
  accent: string;
  presets: Preset[];
}

const PRESET_CATEGORIES: PresetCategory[] = [
  {
    label: 'Whiteboards & Flowcharts',
    icon: Globe,
    accent: 'text-yellow-400',
    presets: [
      {
        label: 'Miro Whiteboards',
        name: 'miro',
        description: 'Official Miro MCP — read/write boards, sticky notes, shapes, frames via secure OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.miro.com/',
        dependency: 'Remote · OAuth (mcp.miro.com)',
        remote: true,
      },
      {
        label: 'Lucidchart',
        name: 'lucid',
        description: 'Official Lucid MCP — flowcharts, diagrams and visual collaboration via secure OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.lucid.app/mcp',
        dependency: 'Remote · OAuth (mcp.lucid.app)',
        remote: true,
      },
      {
        label: 'Excalidraw',
        name: 'excalidraw',
        description: 'Whiteboard diagrams from Mermaid syntax — converts to Excalidraw scenes with live preview',
        command: 'npx',
        args: ['-y', 'mcp-excalidraw'],
        envKeys: [],
        dependency: 'npx -y mcp-excalidraw',
      },
      {
        label: 'Mermaid',
        name: 'mermaid',
        description: 'Generate flowcharts, sequence diagrams, gantt, class & state diagrams from Markdown-like text',
        command: 'npx',
        args: ['-y', 'mcp-mermaid@latest'],
        envKeys: [],
        dependency: 'npx -y mcp-mermaid@latest',
      },
      {
        label: 'PlantUML',
        name: 'plantuml',
        description: 'Generate UML sequence, class, activity and component diagrams from simple text',
        command: 'npx',
        args: ['-y', 'plantuml-mcp-server'],
        envKeys: [],
        dependency: 'npx -y plantuml-mcp-server',
      },
      {
        label: 'draw.io',
        name: 'drawio',
        description: 'Create and manage draw.io diagrams programmatically via mxGraph',
        command: 'npx',
        args: ['-y', 'drawio-mcp-server'],
        envKeys: [],
        dependency: 'npx -y drawio-mcp-server',
      },
    ],
  },
  {
    label: 'Web & Scraping',
    icon: Globe,
    accent: 'text-sky-400',
    presets: [
      {
        label: 'Apify',
        name: 'apify',
        description: 'Access 3,000+ web scraping & automation actors (RAG web browser, email, social)',
        command: 'npx',
        args: ['-y', '@apify/actors-mcp-server@latest'],
        envKeys: ['APIFY_TOKEN'],
        keyGetUrl: 'https://console.apify.com/settings/integrations',
        keyGetLabel: 'Get APIFY_TOKEN',
        dependency: 'npx -y @apify/actors-mcp-server@latest',
      },
      {
        label: 'Fetcher (Browser)',
        name: 'mcp-server-fetch',
        description: 'Fetch URLs, convert HTML to Markdown, PDF/scraping via real browser',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        envKeys: [],
        dependency: 'uvx mcp-server-fetch (needs Python/uv)',
      },
      {
        label: 'Firecrawl',
        name: 'mcp-server-firecrawl',
        description: 'Web scraping, crawling and search API for AI agents',
        command: 'npx',
        args: ['-y', 'firecrawl-mcp'],
        envKeys: ['FIRECRAWL_API_KEY'],
        keyGetUrl: 'https://firecrawl.dev',
        keyGetLabel: 'Get FIRECRAWL_API_KEY',
        dependency: 'npx -y firecrawl-mcp',
      },
      {
        label: 'Tavily Search',
        name: 'tavily-mcp',
        description: 'Fast AI-native web search with fresh, structured results',
        command: 'npx',
        args: ['-y', 'tavily-mcp@latest'],
        envKeys: ['TAVILY_API_KEY'],
        keyGetUrl: 'https://app.tavily.com',
        keyGetLabel: 'Get TAVILY_API_KEY',
        dependency: 'npx -y tavily-mcp@latest',
      },
      {
        label: 'Exa (Search)',
        name: 'mcp-exa',
        description: 'Semantic web & code search API with live embeddings',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        envKeys: ['EXA_API_KEY'],
        keyGetUrl: 'https://exa.ai',
        keyGetLabel: 'Get EXA_API_KEY',
        dependency: 'npx -y exa-mcp-server',
      },
    ],
  },
  {
    label: 'Code & Git',
    icon: Code2,
    accent: 'text-emerald-400',
    presets: [
      {
        label: 'GitHub',
        name: 'github-mcp-server',
        description: 'Full GitHub API: repos, issues, PRs, code search, actions',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        keyGetUrl: 'https://github.com/settings/tokens',
        keyGetLabel: 'Get GITHUB_PERSONAL_ACCESS_TOKEN',
        dependency: 'npx -y @modelcontextprotocol/server-github',
      },
      {
        label: 'GitLab',
        name: 'gitlab-mcp-server',
        description: 'GitLab API: projects, MRs, pipelines, issues',
        command: 'npx',
        args: ['-y', 'mcp-gitlab'],
        envKeys: ['GITLAB_TOKEN', 'GITLAB_URL'],
        keyGetUrl: 'https://gitlab.com/-/profile/personal_access_tokens',
        keyGetLabel: 'Get GITLAB_TOKEN',
        dependency: 'npx -y mcp-gitlab',
      },
      {
        label: 'SQLite (read/write)',
        name: 'mcp-server-sqlite',
        description: 'Query and create SQLite databases via SQL',
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db-path', '~/.smokemonkey/app.db'],
        envKeys: [],
        dependency: 'uvx mcp-server-sqlite (needs Python/uv)',
      },
      {
        label: 'Playwright',
        name: 'playwright-mcp',
        description: 'Real browser automation: navigation, clicks, screenshots, PDF export',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        envKeys: [],
        dependency: 'npx -y @playwright/mcp@latest',
      },
    ],
  },
  {
    label: 'Databases & Storage',
    icon: Database,
    accent: 'text-violet-400',
    presets: [
      {
        label: 'PostgreSQL',
        name: 'postgres-mcp-server',
        description: 'Inspect & query Postgres schemas/tables, run read/write SQL',
        command: 'npx',
        args: ['-y', 'postgres-mcp-server'],
        envKeys: ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_SSL'],
        keyGetLabel: 'PostgreSQL connection details',
        dependency: 'npx -y postgres-mcp-server',
      },
      {
        label: 'MongoDB',
        name: 'mongodb-mcp-server',
        description: 'Explore and query MongoDB collections',
        command: 'npx',
        args: ['-y', 'mongodb-mcp-server'],
        envKeys: ['MONGODB_URI'],
        keyGetLabel: 'MongoDB connection string (MongoDB Atlas: cloud.mongodb.com)',
        dependency: 'npx -y mongodb-mcp-server',
      },
      {
        label: 'Redis',
        name: 'redis-mcp-server',
        description: 'Interact with Redis keys, hashes and sorted sets (localhost:6379 by default)',
        command: 'npx',
        args: ['-y', 'redis-mcp', '--redis-host', 'localhost', '--redis-port', '6379'],
        envKeys: [],
        dependency: 'npx -y redis-mcp',
      },
    ],
  },
  {
    label: 'Observability & Dev Tools',
    icon: Activity,
    accent: 'text-amber-400',
    presets: [
      {
        label: 'Sentry',
        name: 'sentry-mcp-server',
        description: 'Create/manage Sentry issues, events, releases from the agent (official)',
        command: 'npx',
        args: ['-y', '@sentry/mcp-server'],
        envKeys: ['SENTRY_ACCESS_TOKEN'],
        keyGetUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
        keyGetLabel: 'Get SENTRY_ACCESS_TOKEN',
        dependency: 'npx -y @sentry/mcp-server',
      },
      {
        label: 'New Relic',
        name: 'newrelic-mcp-server',
        description: 'Run NRQL queries, dashboards and alerts (NRQL query tools)',
        command: 'npx',
        args: ['-y', 'newrelic-mcp'],
        envKeys: ['NEW_RELIC_API_KEY', 'NEW_RELIC_ACCOUNT_ID'],
        keyGetUrl: 'https://one.newrelic.com/admin-portal/api-keys/home',
        keyGetLabel: 'Get NEW_RELIC_API_KEY',
        dependency: 'npx -y newrelic-mcp',
      },
    ],
  },
  {
    label: 'Communication & Productivity',
    icon: MessageSquare,
    accent: 'text-pink-400',
    presets: [
      {
        label: 'Slack',
        name: 'slack-mcp-server',
        description: 'Post to Slack, list channels, read threads and messages',
        command: 'docker',
        args: ['run', '--rm', '-i', '-e', 'SLACK_BOT_TOKEN', '-e', 'SLACK_TEAM_ID', 'mcp/slack'],
        envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
        keyGetUrl: 'https://api.slack.com/apps',
        keyGetLabel: 'Get SLACK_BOT_TOKEN (needs Docker)',
        dependency: 'docker run --rm -i mcp/slack (needs Docker)',
      },
      {
        label: 'Linear',
        name: 'linear-mcp-server',
        description: 'Create and manage issues, cycles and roadmaps in Linear',
        command: 'npx',
        args: ['-y', 'linear-mcp-server'],
        envKeys: ['LINEAR_API_KEY'],
        keyGetUrl: 'https://linear.app/settings/api',
        keyGetLabel: 'Get LINEAR_API_KEY',
        dependency: 'npx -y linear-mcp-server',
      },
      {
        label: 'Notion',
        name: 'notion-mcp-server',
        description: 'Search, read and write Notion pages, databases and comments (official Notion MCP)',
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        envKeys: ['NOTION_TOKEN'],
        keyGetUrl: 'https://www.notion.so/my-integrations',
        keyGetLabel: 'Get NOTION_TOKEN',
        dependency: 'npx -y @notionhq/notion-mcp-server',
      },
      {
        label: 'Jira',
        name: 'jira-mcp-server',
        description: 'JQL search and detailed issue retrieval from Jira (Jira Cloud)',
        command: 'npx',
        args: ['-y', 'jira-mcp'],
        envKeys: ['JIRA_INSTANCE_URL', 'JIRA_USER_EMAIL', 'JIRA_API_KEY'],
        keyGetUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
        keyGetLabel: 'Get JIRA_API_KEY',
        dependency: 'npx -y jira-mcp',
      },
    ],
  },
  {
    label: 'AI & Vector Search',
    icon: BrainCircuit,
    accent: 'text-cyan-400',
    presets: [
      {
        label: 'Pinecone',
        name: 'pinecone-mcp',
        description: 'Search Pinecone docs, list/describe/create indexes, upsert & query vectors (official)',
        command: 'npx',
        args: ['-y', '@pinecone-database/mcp'],
        envKeys: ['PINECONE_API_KEY'],
        keyGetUrl: 'https://app.pinecone.io',
        keyGetLabel: 'Get PINECONE_API_KEY',
        dependency: 'npx -y @pinecone-database/mcp',
      },
      {
        label: 'Qdrant',
        name: 'qdrant-mcp',
        description: 'State-of-the-art vector search with filtering (official Qdrant MCP)',
        command: 'uvx',
        args: ['mcp-server-qdrant'],
        envKeys: ['QDRANT_URL', 'QDRANT_API_KEY', 'COLLECTION_NAME'],
        keyGetUrl: 'https://cloud.qdrant.io',
        keyGetLabel: 'Get QDRANT_API_KEY',
        dependency: 'uvx mcp-server-qdrant (needs Python/uv)',
      },
      {
        label: 'Memory (Knowledge Graph)',
        name: 'memory-mcp',
        description: 'Persistent agent memory — store entities, relations and observations (keyless)',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        envKeys: [],
        dependency: 'npx -y @modelcontextprotocol/server-memory',
      },
    ],
  },
  {
    label: 'Cloudflare',
    icon: Cloud,
    accent: 'text-orange-400',
    presets: [
      {
        label: 'Cloudflare API',
        name: 'cloudflare-api',
        description: 'Full Cloudflare API — DNS, Workers, R2, Zero Trust and 2,500+ endpoints via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.cloudflare.com/mcp',
        dependency: 'Remote · OAuth (mcp.cloudflare.com)',
        remote: true,
      },
    ],
  },
  {
    label: 'Hosting & Backend',
    icon: Server,
    accent: 'text-emerald-400',
    presets: [
      {
        label: 'Render',
        name: 'render',
        description: 'Deploy and manage web services, static sites, cron jobs and managed Postgres/Redis — hosts the Smoke Monkey backend',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.render.com/mcp',
        dependency: 'Remote · OAuth (mcp.render.com)',
        remote: true,
      },
      {
        label: 'Supabase',
        name: 'supabase',
        description: 'Hosted Postgres, auth, storage and edge functions — query tables, run SQL, apply migrations via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.supabase.com/mcp',
        dependency: 'Remote · OAuth (mcp.supabase.com)',
        remote: true,
      },
      {
        label: 'Netlify',
        name: 'netlify',
        description: 'Deploy static sites and serverless functions — manage projects, build hooks and environment variables (opens browser for OAuth)',
        command: 'npx',
        args: ['-y', '@netlify/mcp'],
        envKeys: ['NETLIFY_AUTH_TOKEN'],
        keyGetUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
        keyGetLabel: 'Personal access token',
        dependency: 'npx -y @netlify/mcp',
      },
      {
        label: 'Vercel',
        name: 'vercel',
        description: 'Deploy the web app to Vercel and manage projects, deployments, environment variables and logs via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.vercel.com',
        dependency: 'Remote · OAuth (mcp.vercel.com)',
        remote: true,
      },
      {
        label: 'Railway',
        name: 'railway',
        description: 'Deploy full-stack apps, services and databases on Railway — manage projects, variables and deploys via OAuth (free $5/mo credit)',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.railway.com',
        dependency: 'Remote · OAuth (mcp.railway.com)',
        remote: true,
      },
      {
        label: 'Fly.io',
        name: 'fly',
        description: 'Provision Fly apps, machines, volumes and secrets — deploy and scale the backend on Fly (free allowance then paid)',
        command: 'fly',
        args: ['mcp', 'server'],
        envKeys: ['FLY_ACCESS_TOKEN'],
        keyGetUrl: 'https://fly.io/docs/security/tokens/',
        keyGetLabel: 'Personal access token (optional)',
        dependency: 'fly mcp server',
      },
      {
        label: 'AWS',
        name: 'aws-nx',
        description: 'Official AWS Nx Plugin — scaffold full-stack apps with Lambda/API Gateway + CDK/S3 and deploy to AWS (free tier + paid)',
        command: 'npx',
        args: ['-y', '@aws/nx-plugin-mcp'],
        envKeys: ['AWS_PROFILE', 'AWS_REGION'],
        keyGetLabel: 'Uses ~/.aws credentials',
        dependency: 'npx -y @aws/nx-plugin-mcp',
      },
      {
        label: 'Azure',
        name: 'azure',
        description: 'Official Azure MCP — manage App Service, compute, databases and more for hosting backends (signs in via az login or env vars)',
        command: 'npx',
        args: ['-y', '@azure/mcp@latest', 'server', 'start'],
        envKeys: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
        keyGetLabel: 'Uses az login or service principal env vars',
        dependency: 'npx -y @azure/mcp server start',
      },
      {
        label: 'Google BigQuery',
        name: 'bigquery',
        description: 'Official Google Cloud MCP — query BigQuery datasets, run SQL and ML analytics (needs a pre-registered Google OAuth client)',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://bigquery.googleapis.com/mcp',
        dependency: 'Remote · Manual OAuth (bigquery.googleapis.com)',
        remote: true,
        manualOAuth: true,
        oauthScopes: 'https://www.googleapis.com/auth/cloud-platform',
      },
      {
        label: 'Google Cloud SQL',
        name: 'cloudsql',
        description: 'Official Google Cloud MCP — create, manage and query Cloud SQL instances (managed Postgres/MySQL for the backend)',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://sqladmin.googleapis.com/mcp',
        dependency: 'Remote · Manual OAuth (sqladmin.googleapis.com)',
        remote: true,
        manualOAuth: true,
        oauthScopes: 'https://www.googleapis.com/auth/cloud-platform',
      },
    ],
  },
];

const TOTAL_PRESETS = PRESET_CATEGORIES.reduce((n, c) => n + c.presets.length, 0);

const BRAND_LOOKUP: Record<string, { Icon: IconType; color: string }> = {
  'apify':   { Icon: ApifyIcon as unknown as IconType, color: 'text-[#F9AA25]' },
  'miro':    { Icon: SiMiro,     color: 'text-[#FFD02F]' },
  'lucid':   { Icon: SiLucid,    color: 'text-[#A9792B]' },
  'excalidraw': { Icon: SiExcalidraw, color: 'text-[#8965CA]' },
  'mermaid': { Icon: SiMermaid,  color: 'text-[#FF3670]' },
  'plantuml':{ Icon: Network,    color: 'text-[#00C7B6]' },
  'drawio':  { Icon: Workflow,   color: 'text-[#F08705]' },
  'slack':   { Icon: FaSlack,    color: 'text-[#E01E5A]' },
  'github':  { Icon: FaGithub,   color: 'text-white' },
  'gitlab':  { Icon: FaGitlab,   color: 'text-[#FC6D26]' },
  'postgres':{ Icon: SiPostgresql, color: 'text-[#4169E1]' },
  'mongo':   { Icon: SiMongodb,  color: 'text-[#47A248]' },
  'redis':   { Icon: SiRedis,    color: 'text-[#DC382D]' },
  'notion':  { Icon: SiNotion,   color: 'text-white' },
  'jira':    { Icon: SiJira,     color: 'text-[#0052CC]' },
  'linear':  { Icon: SiLinear,   color: 'text-[#5E6AD2]' },
  'sentry':  { Icon: SiSentry,   color: 'text-[#8C54FF]' },
  'relic':   { Icon: SiIfttt,    color: 'text-[#1FB5E5]' },
  'qdrant':  { Icon: SiQdrant,   color: 'text-[#FF355D]' },
  'docker':  { Icon: FaDocker,   color: 'text-[#2496ED]' },
  'exa':     { Icon: FaGlobe,    color: 'text-[#22D3EE]' },
  'firecrawl':{ Icon: FaFire,    color: 'text-[#FF6B35]' },
  'playwright':{ Icon: SiBrave,  color: 'text-[#FB542B]' },
  'sqlite':  { Icon: SiSqlite,   color: 'text-[#003B57]' },
  'memory':  { Icon: Brain,      color: 'text-[#FBBF24]' },
  'cloudflare': { Icon: SiCloudflare, color: 'text-[#F6821F]' },
  'render':    { Icon: SiRender, color: 'text-[#1D2B39]' },
  'vercel':    { Icon: SiVercel, color: 'text-white' },
  'supabase':  { Icon: SiSupabase, color: 'text-[#3ECF8E]' },
  'netlify':   { Icon: SiNetlify, color: 'text-[#00C7B7]' },
  'railway':   { Icon: SiRailway, color: 'text-white' },
  'fly':       { Icon: Plane, color: 'text-[#A21CAF]' },
  'aws':       { Icon: FaAws, color: 'text-[#FF9900]' },
  'azure':     { Icon: FaMicrosoft, color: 'text-[#0078D4]' },
  'bigquery':  { Icon: SiGooglecloud, color: 'text-[#4285F4]' },
  'cloudsql':  { Icon: SiGooglecloud, color: 'text-[#4285F4]' },
};

function brandFor(name: string): { Icon: IconType; color: string } {
  const lower = name.toLowerCase();
  for (const key of Object.keys(BRAND_LOOKUP)) {
    if (lower.includes(key)) return BRAND_LOOKUP[key];
  }
  return { Icon: Plug, color: 'text-ink-muted' };
}

export default function McpPage() {
  const toast = useToast();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; tools?: number; error?: string } | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formCommand, setFormCommand] = useState('npx');
  const [formArgs, setFormArgs] = useState('');
  const [formEnv, setFormEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [formTransport, setFormTransport] = useState<'stdio' | 'http'>('stdio');
  const [formUrl, setFormUrl] = useState('');
  const [formManualOAuth, setFormManualOAuth] = useState(false);
  const [formOauthClientId, setFormOauthClientId] = useState('');
  const [formOauthClientSecret, setFormOauthClientSecret] = useState('');
  const [formOauthScopes, setFormOauthScopes] = useState('');
  const [saving, setSaving] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState<string | null>(null);
  const [oauthPolling, setOauthPolling] = useState<string | null>(null);
  const envRef = useRef<HTMLDivElement>(null);
  const catalogScrollRef = useRef<HTMLDivElement>(null);

  const loadServers = useCallback(async () => {
    try {
      const res = await api.listMcpServers();
      setServers(res.servers as McpServer[]);
    } catch (err) {
      toast.error('Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadServers(); }, [loadServers]);

  const handleSave = async () => {
    if (!formName.trim()) return toast.error('Name is required');
    if (isConfigured(formName)) {
      toast.error(`"${formName.trim()}" is already configured`);
      return;
    }
    if (formTransport === 'http') {
      if (!formUrl.trim()) return toast.error('URL is required for remote HTTP servers');
    } else {
      if (!formCommand.trim()) return toast.error('Command is required');
    }
    setSaving(true);
    try {
      const args = formArgs.trim() ? formArgs.trim().split(/\s+/) : [];
      const env: Record<string, string> = {};
      for (const pair of formEnv) {
        if (pair.key.trim() && pair.value.trim()) env[pair.key.trim()] = pair.value.trim();
      }
      await api.createMcpServer({
        name: formName.trim(),
        description: formDesc.trim(),
        transport: formTransport,
        command: formTransport === 'http' ? '' : formCommand.trim(),
        args: formTransport === 'http' ? [] : args,
        env: formTransport === 'http' ? undefined : Object.keys(env).length > 0 ? env : undefined,
        url: formTransport === 'http' ? formUrl.trim() : undefined,
        ...(formManualOAuth
          ? {
              oauthClientId: formOauthClientId.trim() || undefined,
              oauthClientSecret: formOauthClientSecret.trim() || undefined,
              oauthScopes: formOauthScopes.trim() || undefined,
            }
          : {}),
      });
      toast.success(`MCP server "${formName}" created`);
      setShowAddForm(false);
      setFormName(''); setFormDesc(''); setFormCommand('npx'); setFormArgs(''); setFormEnv([]);
      setFormTransport('stdio'); setFormUrl('');
      setFormManualOAuth(false); setFormOauthClientId(''); setFormOauthClientSecret(''); setFormOauthScopes('');
      loadServers();
    } catch (err) {
      toast.error('Failed to create MCP server');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete MCP server "${name}"?`)) return;
    try {
      await api.deleteMcpServer(id);
      toast.success(`Deleted "${name}"`);
      loadServers();
    } catch {
      toast.error('Failed to delete');
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await api.updateMcpServer(id, { enabled });
      loadServers();
    } catch {
      toast.error('Failed to toggle');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const res = await api.testMcpServer(id);
      setTestResult({ id, ok: res.ok, tools: res.tools?.length, error: res.error });
    } catch {
      setTestResult({ id, ok: false, error: 'Test failed' });
    } finally {
      setTestingId(null);
    }
  };

  const handleOAuthConnect = async (srv: McpServer) => {
    setOauthConnecting(srv.id);
    try {
      const res = await api.startMcpOAuth(srv.id);
      await openExternalUrl(res.authUrl);
      // Poll until the server shows connected (max 2 minutes)
      setOauthPolling(srv.id);
      const start = Date.now();
      while (Date.now() - start < 120_000) {
        await new Promise((r) => setTimeout(r, 2000));
        const { servers: refreshed } = await api.listMcpServers();
        const fresh = refreshed.find((s) => s.id === srv.id);
        if (fresh?.oauthConnected) {
          toast.success(`Connected to ${srv.name}`);
          loadServers();
          break;
        }
      }
    } catch (err) {
      toast.error('OAuth connect failed');
    } finally {
      setOauthConnecting(null);
      setOauthPolling(null);
    }
  };

  const handleOAuthDisconnect = async (srv: McpServer) => {
    try {
      await api.disconnectMcpOAuth(srv.id);
      toast.success(`Disconnected ${srv.name}`);
      loadServers();
    } catch {
      toast.error('Disconnect failed');
    }
  };

  const configuredNames = useMemo(() => new Set(servers.map((s) => s.name.trim().toLowerCase())), [servers]);

  const isConfigured = (name: string) => configuredNames.has(name.trim().toLowerCase());

  const applyPreset = (sample: Preset) => {
    if (isConfigured(sample.name)) {
      toast.error(`"${sample.name}" is already configured`);
      return;
    }
    const isRemote = sample.remote || sample.transport === 'http';
    setFormName(sample.name);
    setFormDesc(sample.description);
    setFormTransport(isRemote ? 'http' : 'stdio');
    setFormUrl(sample.url ?? '');
    setFormCommand(sample.command || 'npx');
    setFormArgs(sample.args.join(' '));
    setFormEnv(sample.envKeys.map((k) => ({ key: k, value: '' })));
    setFormManualOAuth(!!sample.manualOAuth);
    setFormOauthClientId('');
    setFormOauthClientSecret('');
    setFormOauthScopes(sample.oauthScopes ?? '');
    setShowAddForm(true);
    requestAnimationFrame(() => {
      if (!isRemote && sample.envKeys.length > 0 && envRef.current) {
        envRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-5 pb-20 sm:px-6 sm:py-6">
      <PageHeader
        title="MCP Servers"
        description="Connect external Model Context Protocol servers to give the agent access to more tools (max 3 active at once)."
      />

        {/* Header row with action */}
        <div className="mb-6 mt-6 flex flex-wrap items-center justify-between gap-3">
          {showAddForm ? (
            <h2 className="text-sm font-semibold text-slate-300">
              Configure new server
            </h2>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-500/20 transition-all hover:shadow-violet-500/40 hover:brightness-110 active:scale-95"
            >
              <Plus className="h-4 w-4" />
              Add MCP Server
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-ink-muted">Configured servers</span>
            <span className="rounded-full bg-surface-800 px-2 py-0.5 text-xs font-semibold text-white">{servers.length}</span>
          </div>
        </div>

        {/* Add form */}
        {showAddForm && (
          <div ref={envRef} className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-card-lift backdrop-blur-md">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Add MCP Server</h3>
              <button type="button" onClick={() => setShowAddForm(false)} className="text-slate-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Preset catalog */}
            <div className="mb-4">
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Catalogue — {TOTAL_PRESETS} presets across {PRESET_CATEGORIES.length} categories. Pick one to prefill.
              </p>
              <div ref={catalogScrollRef} className="max-h-[420px] overflow-y-auto pr-1">
                <div className="grid gap-3 sm:grid-cols-2">
                {PRESET_CATEGORIES.map((cat) => {
                  const CatIcon = cat.icon;
                  return (
                    <div key={cat.label} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                        <span className={cn('flex h-5 w-5 items-center justify-center rounded-md bg-slate-800', cat.accent)}>
                          <CatIcon className="h-3.5 w-3.5" />
                        </span>
                        {cat.label}
                      </p>
                    <div className="space-y-1.5">
                      {cat.presets.map((p) => {
                        const { Icon: BrandIcon, color: brandColor } = brandFor(p.name);
                        const apifyBrand = isApify(p.name);
                        const added = isConfigured(p.name);
                        return (
                          <button
                            key={p.name}
                            type="button"
                            onClick={() => applyPreset(p)}
                            disabled={added}
                            className={cn(
                              'block w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                              added
                                ? 'border-emerald-500/40 bg-emerald-500/5 opacity-80'
                                : 'border-slate-800 bg-slate-950/60 hover:border-violet-500/50 hover:bg-slate-900',
                            )}
                          >
                            <span className="flex items-center gap-2">
                              {apifyBrand ? (
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                                  <ApifyIcon className="h-6 w-6 text-[#F9AA25] drop-shadow-[0_0_8px_rgba(249,170,37,0.65)]" />
                                </span>
                              ) : (
                                <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-800', brandColor)}>
                                  <BrandIcon className="h-4 w-4" />
                                </span>
                              )}
                              <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">{p.label}</span>
                              {added ? (
                                <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                                  ✓ Added
                                </span>
                              ) : (
                                p.remote && (
                                  <span className="shrink-0 rounded bg-yellow-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-yellow-300">
                                    Remote · OAuth
                                  </span>
                                )
                              )}
                            </span>
                            <span className="mt-1 block text-[11px] leading-snug text-slate-400">{p.description}</span>
                            <span className="mt-1 block font-mono text-[10px] text-slate-500">{p.dependency}</span>
                            {p.envKeys.length > 0 && (
                              <span className="mt-1 flex flex-wrap items-center gap-1">
                                {p.envKeys.map((k) => (
                                  <span
                                    key={k}
                                    className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.15)]"
                                  >
                                    {k}
                                  </span>
                                ))}
                                {p.keyGetUrl && (
                                  <a
                                    href={p.keyGetUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-[10px] font-medium text-sky-300 underline underline-offset-2 hover:text-sky-200"
                                  >
                                    {p.keyGetLabel ?? 'Get key'}
                                  </a>
                                )}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  );
                })}
              </div>
              </div>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Name *</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. apify"
                  className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Description</label>
                <input
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder="Short description for the agent"
                  className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>
              {formTransport === 'http' ? (
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Remote URL *</label>
                  <input
                    value={formUrl}
                    onChange={(e) => setFormUrl(e.target.value)}
                    placeholder="https://mcp.miro.com/"
                    className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                  <p className="mt-1 text-[11px] text-yellow-400">You will connect via OAuth after saving. No command required.</p>
                  {formManualOAuth && (
                    <>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-slate-400">OAuth Client ID</label>
                          <input
                            value={formOauthClientId}
                            onChange={(e) => setFormOauthClientId(e.target.value)}
                            placeholder="4xxxxxx.apps.googleusercontent.com"
                            className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-slate-400">OAuth Client Secret</label>
                          <input
                            type="password"
                            value={formOauthClientSecret}
                            onChange={(e) => setFormOauthClientSecret(e.target.value)}
                            placeholder="GOCSPX-..."
                            className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="mb-1.5 block text-xs font-medium text-slate-400">OAuth Scopes</label>
                          <input
                            value={formOauthScopes}
                            onChange={(e) => setFormOauthScopes(e.target.value)}
                            placeholder="https://www.googleapis.com/auth/cloud-platform"
                            className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                          <p className="mt-1 text-[11px] text-slate-400">Create a Google Cloud "Web application" OAuth client and add the redirect URI:</p>
                          <code className="mt-1 block rounded bg-slate-800/80 px-2 py-1 text-[11px] text-cyan-300">http://127.0.0.1:8642/api/mcp/oauth/callback</code>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">Command *</label>
                    <input
                      value={formCommand}
                      onChange={(e) => setFormCommand(e.target.value)}
                      placeholder="npx"
                      className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">Args (space-separated)</label>
                    <input
                      value={formArgs}
                      onChange={(e) => setFormArgs(e.target.value)}
                      placeholder="-y @apify/actors-mcp-server@latest"
                      className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Env key/value pairs */}
            <div className="mt-6">
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-slate-400">
                  Environment Variables <span className="text-slate-500">(key = value)</span>
                </label>
                <button
                  type="button"
                  onClick={() => setFormEnv((e) => [...e, { key: '', value: '' }])}
                  className="text-xs font-medium text-violet-400 hover:text-violet-300"
                >
                  + Add variable
                </button>
              </div>
              {formEnv.length === 0 && (
                <p className="text-xs text-slate-500">No env vars. Most servers work keyless; some need an API key above.</p>
              )}
              <div className="space-y-2">
                {formEnv.map((pair, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={pair.key}
                      onChange={(e) =>
                        setFormEnv((arr) => arr.map((p, idx) => (idx === i ? { ...p, key: e.target.value } : p)))
                      }
                      placeholder="SLACK_BOT_TOKEN"
                      className="w-1/3 rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                    <span className="text-slate-500">=</span>
                    <input
                      value={pair.value}
                      onChange={(e) =>
                        setFormEnv((arr) => arr.map((p, idx) => (idx === i ? { ...p, value: e.target.value } : p)))
                      }
                      type="password"
                      placeholder="value"
                      className="flex-1 rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                    <button
                      type="button"
                      onClick={() => setFormEnv((arr) => arr.filter((_, idx) => idx !== i))}
                      className="shrink-0 rounded-lg border border-slate-700/60 bg-slate-900/80 px-2 py-2 text-slate-400 hover:border-red-500/30 hover:text-red-300"
                      title="Remove variable"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-violet-500/20 transition-all hover:shadow-violet-500/40 hover:brightness-110 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save Server
              </button>
            </div>
          </div>
        )}

        {/* Server list */}
        <div className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-2xl border border-surface-700 bg-surface-900/50 p-12 text-center">
            <Plug className="mx-auto mb-4 h-10 w-10 text-ink-muted" />
            <p className="text-sm text-ink-muted">No MCP servers configured yet.</p>
            <p className="mt-1 text-xs text-ink-muted/60">
              Add a server above to give the agent access to external tools.
            </p>
          </div>
        ) : (
          <div className="space-y-3 pb-8">
            {servers.map((srv) => (
              <div
                key={srv.id}
                className={cn(
                  'rounded-xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md transition-all hover:border-slate-700',
                  !srv.enabled && 'border-slate-800/50 opacity-60',
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    {isApify(srv.name) ? (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
                        <ApifyIcon className="ml-0.5 h-8 w-8 text-[#F9AA25] drop-shadow-[0_0_10px_rgba(249,170,37,0.7)]" />
                      </div>
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-700">
                        {(() => {
                          const { Icon, color: brandColor } = brandFor(srv.name);
                          return <Icon className={cn('h-4 w-4', brandColor)} />;
                        })()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="truncate text-sm font-medium text-white">{srv.name}</h4>
                        {srv.transport === 'http' && (
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-medium',
                              srv.oauthConnected
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-yellow-500/15 text-yellow-300',
                            )}
                          >
                            OAuth
                          </span>
                        )}
                        {!srv.enabled && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">disabled</span>
                        )}
                      </div>
                      {srv.description && (
                        <p className="mt-0.5 text-xs text-ink-muted">{srv.description}</p>
                      )}
                      {srv.transport === 'http' ? (
                        <p className="mt-1 font-mono text-[11px] text-ink-muted/60">
                          {srv.url ?? 'http'}
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 font-mono text-[11px] text-ink-muted/60">
                            {srv.command} {srv.args.join(' ')}
                          </p>
                          {srv.env && Object.keys(srv.env).length > 0 && (
                            <p className="mt-0.5 font-mono text-[11px] text-ink-muted/60">
                              env: {Object.keys(srv.env).join(', ')}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-slate-800 bg-slate-950/60 p-1 backdrop-blur-md">
                    {/* Remote servers: OAuth connect flow */}
                    {srv.transport === 'http' ? (
                      srv.oauthConnected ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleTest(srv.id)}
                            disabled={testingId === srv.id}
                            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
                            title="Test connection"
                          >
                            {testingId === srv.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : testResult?.id === srv.id && testResult.ok ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : testResult?.id === srv.id && !testResult.ok ? (
                              <AlertTriangle className="h-3 w-3 text-amber-400" />
                            ) : (
                              <FileText className="h-3 w-3" />
                            )}
                            {testResult?.id === srv.id && testResult.ok
                              ? `${testResult.tools} tools`
                              : testResult?.id === srv.id && !testResult.ok
                              ? 'Failed'
                              : 'Test'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOAuthDisconnect(srv)}
                            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                            title="Disconnect OAuth"
                          >
                            <PowerOff className="h-3 w-3" />
                            Disconnect
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleOAuthConnect(srv)}
                          disabled={oauthConnecting === srv.id || oauthPolling === srv.id}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 px-3 py-1.5 text-[11px] font-semibold text-black shadow-lg shadow-amber-500/20 transition-all hover:brightness-110 disabled:opacity-60"
                          title="Connect this server via OAuth"
                        >
                          {oauthConnecting === srv.id || oauthPolling === srv.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Plug className="h-3 w-3" />
                          )}
                          {oauthConnecting === srv.id
                            ? 'Opening…'
                            : oauthPolling === srv.id
                            ? 'Waiting…'
                            : 'Connect'}
                        </button>
                      )
                    ) : (
                      <>
                      {/* Test button */}
                      <button
                        type="button"
                        onClick={() => handleTest(srv.id)}
                        disabled={testingId === srv.id}
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
                        title="Test connection"
                      >
                        {testingId === srv.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : testResult?.id === srv.id && testResult.ok ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : testResult?.id === srv.id && !testResult.ok ? (
                          <AlertTriangle className="h-3 w-3 text-amber-400" />
                        ) : (
                          <FileText className="h-3 w-3" />
                        )}
                        {testResult?.id === srv.id && testResult.ok
                          ? `${testResult.tools} tools`
                          : testResult?.id === srv.id && !testResult.ok
                          ? 'Failed'
                          : 'Test'}
                      </button>

                      {/* Enable/disable toggle */}
                      <button
                        type="button"
                        onClick={() => handleToggle(srv.id, !srv.enabled)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                          srv.enabled
                            ? 'text-emerald-300 hover:bg-emerald-500/15'
                            : 'text-slate-400 hover:bg-white/5 hover:text-white',
                        )}
                        title={srv.enabled ? 'Disable server' : 'Enable server'}
                      >
                        {srv.enabled ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
                        {srv.enabled ? 'On' : 'Off'}
                      </button>
                      </>
                    )}

                    {/* Delete */}
                    <button
                      type="button"
                      onClick={() => handleDelete(srv.id, srv.name)}
                      className="inline-flex items-center rounded-lg px-2 py-1.5 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                      title="Delete server"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Test result detail */}
                {testResult?.id === srv.id && testResult.error && (
                  <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {testResult.error}
                  </p>
                )}
              </div>
            ))}

            {/* Max 3 hint */}
            <p className="pt-2 text-center text-xs text-slate-500">
              Max 3 MCP servers can be active at once during an agent run.
            </p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
