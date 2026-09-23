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
  ChevronRight,
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
  Search,
  Zap,
  ShoppingBag,
  FileJson,
  Settings2,
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
  FaFigma,
  FaDropbox,
  FaPaypal,
  FaApple,
  FaAmazon,
  FaUtensils,
  FaUbuntu,
  FaJira,
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
  SiGoogle,
  SiGoogledrive,
  SiGmail,
  SiGooglecalendar,
  SiGooglemaps,
  SiHuggingface,
  SiJupyter,
  SiSpotify,
  SiYoutube,
  SiStripe,
  SiShopify,
  SiCoinmarketcap,
  SiTodoist,
  SiAsana,
  SiTrello,
  SiGrafana,
  SiDatadog,
  SiPrometheus,
  SiTelegram,
  SiMysql,
  SiMariadb,
  SiMattermost,
  SiRocketdotchat,
  SiHomeassistant,
  SiTerraform,
  SiKubernetes,
  SiMinio,
  SiSwagger,
  SiN8N,
  SiAirtable,
  SiAuth0,
  SiElasticsearch,
  SiTypescript,
  SiPython,
  SiTailwindcss,
  SiVuedotjs,
  SiCanvas,
} from 'react-icons/si';
import {
  MdEmail,
  MdCalendarMonth,
  MdOutlineDashboard,
  MdPassword,
  MdLock,
  MdDraw,
} from 'react-icons/md';
import {
  TbBrandTrello,
  TbApi,
  TbBrain,
  TbFileCode,
  TbCurrencyBitcoin,
  TbReportAnalytics,
} from 'react-icons/tb';
import type { IconType } from 'react-icons';
import type { McpStockCatalogResponseDto, McpStockEntryDto } from '@rag/contracts';
import { ApifyIcon, isApify } from '../../components/BrandIconResolver';
import { api } from '../../lib/api';
import { useMcpList } from '../../lib/mcp-store';
import { openExternalUrl } from '../../lib/external-links';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toast';
import { cn } from '../../lib/utils';
import { McpTokenDialog } from '../../components/agent/McpTokenDialog';

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
  icon?: string | null;
  category?: string | null;
  tags?: string[];
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
      {
        label: 'Brave Search',
        name: 'brave-search',
        description: 'Web search via Brave Search API — fast, privacy-first results',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        envKeys: ['BRAVE_API_KEY'],
        keyGetUrl: 'https://brave.com/search/api/',
        keyGetLabel: 'Get BRAVE_API_KEY',
        dependency: 'npx -y @modelcontextprotocol/server-brave-search',
      },
      {
        label: 'Google Search',
        name: 'google-search',
        description: 'Google Custom Search JSON API — search the web with Google results',
        command: 'npx',
        args: ['-y', 'mcp-google-search'],
        envKeys: ['GOOGLE_API_KEY', 'GOOGLE_SEARCH_ENGINE_ID'],
        keyGetUrl: 'https://programmablesearchengine.google.com/',
        keyGetLabel: 'Get API key + Engine ID',
        dependency: 'npx -y mcp-google-search',
      },
      {
        label: 'Google Maps',
        name: 'google-maps',
        description: 'Places, directions, geocoding and elevation via Google Maps Platform',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-google-maps'],
        envKeys: ['GOOGLE_MAPS_API_KEY'],
        keyGetUrl: 'https://console.cloud.google.com/apis/credentials',
        keyGetLabel: 'Get GOOGLE_MAPS_API_KEY',
        dependency: 'npx -y @modelcontextprotocol/server-google-maps',
      },
      {
        label: 'Puppeteer',
        name: 'puppeteer',
        description: 'Headless Chrome browser automation — screenshots, scraping, PDF generation',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
        envKeys: [],
        dependency: 'npx -y @modelcontextprotocol/server-puppeteer',
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
        label: 'Git',
        name: 'git-mcp',
        description: 'General-purpose Git operations — commits, branches, diffs, history (keyless)',
        command: 'npx',
        args: ['-y', 'git-mcp', '--repository', '/path/to/repo'],
        envKeys: [],
        dependency: 'npx -y git-mcp',
      },
      {
        label: 'Filesystem',
        name: 'filesystem-mcp',
        description: 'Read/write files and directories, search, list and edit text files (keyless)',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        envKeys: [],
        dependency: 'npx -y @modelcontextprotocol/server-filesystem',
      },
      {
        label: 'TypeScript SDK',
        name: 'typescript-sdk',
        description: 'Execute TypeScript safely inside a V8 isolate (keyless)',
        command: 'npx',
        args: ['-y', 'typescript-sdk'],
        envKeys: [],
        dependency: 'npx -y typescript-sdk',
      },
      {
        label: 'Everything (Sample)',
        name: 'everything',
        description: 'Reference MCP server hosting every tool/resource type — great for testing the agent (keyless)',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
        envKeys: [],
        dependency: 'npx -y @modelcontextprotocol/server-everything',
      },
      {
        label: 'Sequential Thinking',
        name: 'sequential-thinking',
        description: 'Structured multi-step reasoning via connected thoughts (keyless)',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        envKeys: [],
        dependency: 'npx -y @modelcontextprotocol/server-sequential-thinking',
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
      {
        label: 'MySQL',
        name: 'mysql-mcp-server',
        description: 'Run SQL, inspect and update MySQL/MariaDB schemas from the agent',
        command: 'npx',
        args: ['-y', 'mysql-mcp-server'],
        envKeys: ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'],
        keyGetLabel: 'MySQL connection details',
        dependency: 'npx -y mysql-mcp-server',
      },
      {
        label: 'SQLite (core)',
        name: 'sqlite',
        description: 'SQLite via the DBQL server — read/write databases with SQL over MCP',
        command: 'npx',
        args: ['-y', 'sqlite-mcp-server', '--db-path', '~/.smokemonkey/app.db'],
        envKeys: [],
        dependency: 'npx -y sqlite-mcp-server',
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
      {
        label: 'Grafana',
        name: 'grafana',
        description: 'Query dashboards, datasources and alerts from your Grafana instance',
        command: 'npx',
        args: ['-y', 'mcp-grafana-npx'],
        envKeys: ['GRAFANA_URL', 'GRAFANA_API_KEY'],
        keyGetUrl: 'https://grafana.com/',
        keyGetLabel: 'Get GRAFANA_URL + API key',
        dependency: 'npx -y mcp-grafana-npx',
      },
      {
        label: 'Prometheus',
        name: 'prometheus',
        description: 'Query Prometheus metrics with PromQL for monitoring and alerting',
        command: 'npx',
        args: ['-y', 'prometheus-mcp'],
        envKeys: ['PROMETHEUS_URL'],
        keyGetLabel: 'PROMETHEUS_URL (e.g. http://localhost:9090)',
        dependency: 'npx -y prometheus-mcp',
      },
      {
        label: 'Datadog',
        name: 'datadog',
        description: 'Query metrics, logs and incidents from Datadog',
        command: 'npx',
        args: ['-y', 'datadog-mcp-server'],
        envKeys: ['DATADOG_API_KEY', 'DATADOG_APP_KEY'],
        keyGetUrl: 'https://app.datadoghq.com/organization-settings/api-keys',
        keyGetLabel: 'Get DATADOG_API_KEY',
        dependency: 'npx -y datadog-mcp-server',
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
      {
        label: 'Mattermost',
        name: 'mattermost',
        description: 'Read channels, post messages and search threads in Mattermost',
        command: 'npx',
        args: ['-y', '@conarti/mattermost-mcp'],
        envKeys: ['MATTERMOST_BASE_URL', 'MATTERMOST_ACCESS_TOKEN'],
        keyGetLabel: 'MATTERMOST_BASE_URL + personal access token',
        dependency: 'npx -y @conarti/mattermost-mcp',
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
      {
        label: 'Hugging Face',
        name: 'hf-inference',
        description: 'Run Hugging Face inference — text generation, embeddings, vision and audio models',
        command: 'npx',
        args: ['-y', 'huggingface-mcp-server'],
        envKeys: ['HF_TOKEN'],
        keyGetUrl: 'https://huggingface.co/settings/tokens',
        keyGetLabel: 'Get HF_TOKEN',
        dependency: 'npx -y huggingface-mcp-server',
      },
      {
        label: 'OpenAI SDK',
        name: 'openai',
        description: 'OpenAI-compatible chat, embeddings and image tools via API key',
        command: 'npx',
        args: ['-y', 'openai-mcp-server'],
        envKeys: ['OPENAI_API_KEY'],
        keyGetUrl: 'https://platform.openai.com/api-keys',
        keyGetLabel: 'Get OPENAI_API_KEY',
        dependency: 'npx -y openai-mcp-server',
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
      {
        label: 'Terraform',
        name: 'terraform',
        description: 'Inspect Terraform state, plan and apply infrastructure as code (official HashiCorp)',
        command: 'npx',
        args: ['-y', 'terraform-mcp-server'],
        envKeys: ['TFC_TOKEN', 'TERRAFORM_REGISTRY_URL'],
        keyGetUrl: 'https://app.terraform.io/app/settings/tokens',
        keyGetLabel: 'Terraform Cloud token (optional)',
        dependency: 'npx -y terraform-mcp-server',
      },
      {
        label: 'Kubernetes',
        name: 'kubernetes',
        description: 'List pods, deployments and namespaces, inspect clusters and apply manifests (keyless, reads ~/.kube/config)',
        command: 'npx',
        args: ['-y', 'mcp-server-kubernetes'],
        envKeys: ['KUBECONFIG'],
        keyGetLabel: 'KUBECONFIG path (default ~/.kube/config)',
        dependency: 'npx -y mcp-server-kubernetes',
      },
    ],
  },
  {
    label: 'File System & Storage',
    icon: Server,
    accent: 'text-indigo-400',
    presets: [
      {
        label: 'Google Drive',
        name: 'gdrive',
        description: 'Official Google Drive MCP — read, search and manage files via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://drive.googleapis.com/mcp',
        dependency: 'Remote · Manual OAuth (drive.googleapis.com)',
        remote: true,
        manualOAuth: true,
        oauthScopes: 'https://www.googleapis.com/auth/drive.readonly',
      },
      {
        label: 'Dropbox',
        name: 'dropbox',
        description: 'List, search, download and upload files in Dropbox',
        command: 'npx',
        args: ['-y', '@pipeworx/mcp-dropbox'],
        envKeys: ['DROPBOX_ACCESS_TOKEN'],
        keyGetUrl: 'https://www.dropbox.com/developers/apps',
        keyGetLabel: 'Create app → get access token',
        dependency: 'npx -y @pipeworx/mcp-dropbox',
      },
      {
        label: 'Filesystem (local)',
        name: 'filesystem-local',
        description: 'Safe local file access — read/write text files, list directories, search (keyless)',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '~'],
        envKeys: [],
        dependency: 'npx -y @modelcontextprotocol/server-filesystem',
      },
      {
        label: 'S3 Storage (AWS)',
        name: 's3-storage',
        description: 'List buckets, browse objects, upload/download and create presigned URLs on S3',
        command: 'npx',
        args: ['-y', 'mcp-server-s3'],
        envKeys: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
        keyGetLabel: 'AWS credentials (or ~/.aws/config)',
        dependency: 'npx -y mcp-server-s3',
      },
    ],
  },
  {
    label: 'Email & Calendar',
    icon: MessageSquare,
    accent: 'text-red-400',
    presets: [
      {
        label: 'Gmail',
        name: 'gmail',
        description: 'Official Gmail MCP — read, search and send email threads via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://gmail.googleapis.com/mcp',
        dependency: 'Remote · Manual OAuth (gmail.googleapis.com)',
        remote: true,
        manualOAuth: true,
        oauthScopes: 'https://www.googleapis.com/auth/gmail.readonly',
      },
      {
        label: 'Google Calendar',
        name: 'gcal',
        description: 'Official Google Calendar MCP — view, create and manage events via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://www.googleapis.com/calendar/v3/mcp',
        dependency: 'Remote · Manual OAuth (calendar)',
        remote: true,
        manualOAuth: true,
        oauthScopes: 'https://www.googleapis.com/auth/calendar.events',
      },
    ],
  },
  {
    label: 'Search & Research',
    icon: BrainCircuit,
    accent: 'text-teal-400',
    presets: [
      {
        label: 'Tavily (AI Search)',
        name: 'tavily',
        description: 'Web search tuned for AI agents — fast, structured, relevant results',
        command: 'npx',
        args: ['-y', 'tavily-mcp@latest'],
        envKeys: ['TAVILY_API_KEY'],
        keyGetUrl: 'https://app.tavily.com',
        keyGetLabel: 'Get TAVILY_API_KEY',
        dependency: 'npx -y tavily-mcp@latest',
      },
      {
        label: 'Exa (Research)',
        name: 'exa',
        description: 'Semantic web search built for AI — research papers, docs, live web content',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        envKeys: ['EXA_API_KEY'],
        keyGetUrl: 'https://exa.ai',
        keyGetLabel: 'Get EXA_API_KEY',
        dependency: 'npx -y exa-mcp-server',
      },
      {
        label: 'Wikipedia',
        name: 'wikipedia',
        description: 'Full-text Wikipedia search and article summaries (official, keyless)',
        command: 'uvx',
        args: ['mcp-server-wikipedia'],
        envKeys: [],
        dependency: 'uvx mcp-server-wikipedia (needs Python/uv)',
      },
      {
        label: 'Arc (Code Search)',
        name: 'arc',
        description: 'Semantic code search across GitHub — find APIs, patterns and examples',
        command: 'npx',
        args: ['-y', 'arc-mcp'],
        envKeys: ['ARCTIC_API_KEY'],
        keyGetUrl: 'https://arc.io',
        keyGetLabel: 'Get ARIO (Arc) API key',
        dependency: 'npx -y arc-mcp',
      },
    ],
  },
  {
    label: 'Productivity & PM',
    icon: Activity,
    accent: 'text-lime-400',
    presets: [
      {
        label: 'Notion',
        name: 'notion-mcp',
        description: 'Search, read and write Notion pages, databases and comments via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.notion.com/mcp',
        dependency: 'Remote · OAuth (mcp.notion.com)',
        remote: true,
      },
      {
        label: 'Linear',
        name: 'linear-mcp',
        description: 'Create and manage issues, cycles and roadmaps in Linear via OAuth login',
        transport: 'http',
        command: '',
        args: [],
        envKeys: [],
        url: 'https://mcp.linear.app/mcp',
        dependency: 'Remote · OAuth (mcp.linear.app)',
        remote: true,
      },
      {
        label: 'Todoist',
        name: 'todoist',
        description: 'Create tasks, projects and manage your to-do list',
        command: 'npx',
        args: ['-y', 'todoist-mcp-server'],
        envKeys: ['TODOIST_API_TOKEN'],
        keyGetUrl: 'https://todoist.com/app/settings/integrations/developer',
        keyGetLabel: 'Get TODOIST_API_TOKEN',
        dependency: 'npx -y todoist-mcp-server',
      },
      {
        label: 'Trello',
        name: 'trello',
        description: 'Manage boards, lists, cards and labels on Trello',
        command: 'npx',
        args: ['-y', 'mcp-trello'],
        envKeys: ['TRELLO_API_KEY', 'TRELLO_API_TOKEN'],
        keyGetUrl: 'https://trello.com/power-ups/admin',
        keyGetLabel: 'Trello API key + token',
        dependency: 'npx -y mcp-trello',
      },
      {
        label: 'Jira',
        name: 'jira-cloud',
        description: 'JQL search, issue retrieval and sprint views for Jira Cloud',
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
    label: 'Data Science & ML',
    icon: Brain,
    accent: 'text-fuchsia-400',
    presets: [
      {
        label: 'Jupyter',
        name: 'jupyter',
        description: 'Run Jupyter notebooks — execute code cells and read outputs (keyless)',
        command: 'uvx',
        args: ['mcp-server-jupyter'],
        envKeys: [],
        dependency: 'uvx mcp-server-jupyter (needs Python/uv)',
      },
      {
        label: 'Hugging Face',
        name: 'huggingface',
        description: 'Dive deep into HF models, datasets, pipelines and inference API',
        command: 'npx',
        args: ['-y', 'huggingface-mcp-server'],
        envKeys: ['HF_TOKEN'],
        keyGetUrl: 'https://huggingface.co/settings/tokens',
        keyGetLabel: 'Get HF_TOKEN',
        dependency: 'npx -y huggingface-mcp-server',
      },
      {
        label: 'BigQuery ML',
        name: 'bigquery-ml',
        description: 'Query BigQuery and run ML models via OAuth login',
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
    ],
  },
  {
    label: 'Media & Content',
    icon: Plane,
    accent: 'text-rose-400',
    presets: [
      {
        label: 'YouTube Transcripts',
        name: 'youtube',
        description: 'Fetch YouTube transcripts, captions and video metadata (MIT, keyless)',
        command: 'npx',
        args: ['-y', 'yt-transcript-mcp'],
        envKeys: [],
        dependency: 'npx -y yt-transcript-mcp',
      },
      {
        label: 'Spotify',
        name: 'spotify',
        description: 'Search music, build playlists and fetch track metadata',
        command: 'uvx',
        args: ['spotify-mcp'],
        envKeys: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
        keyGetUrl: 'https://developer.spotify.com/dashboard',
        keyGetLabel: 'Get Spotify client credentials',
        dependency: 'uvx spotify-mcp (needs Python/uv)',
      },
    ],
  },
  {
    label: 'Finance & Crypto',
    icon: BrainCircuit,
    accent: 'text-amber-400',
    presets: [
      {
        label: 'Stripe',
        name: 'stripe',
        description: 'Manage payments, customers, products and subscriptions',
        command: 'npx',
        args: ['-y', '@stripe/mcp'],
        envKeys: ['STRIPE_SECRET_KEY'],
        keyGetUrl: 'https://dashboard.stripe.com/apikeys',
        keyGetLabel: 'Get STRIPE_SECRET_KEY',
        dependency: 'npx -y @stripe/mcp',
      },
    ],
  },
  {
    label: 'Security & Auth',
    icon: Cloud,
    accent: 'text-cyan-400',
    presets: [
      {
        label: 'Auth0',
        name: 'auth0',
        description: 'Manage Auth0 tenants, users, clients and rules (official MCP)',
        command: 'npx',
        args: ['-y', '@auth0/auth0-mcp-server'],
        envKeys: ['AUTH0_DOMAIN', 'AUTH0_MANAGEMENT_CLIENT_ID', 'AUTH0_MANAGEMENT_CLIENT_SECRET'],
        keyGetUrl: 'https://manage.auth0.com/dashboard/',
        keyGetLabel: 'Auth0 Management API app',
        dependency: 'npx -y @auth0/auth0-mcp-server',
      },
      {
        label: '1Password',
        name: '1password',
        description: 'Read/write 1Password vault entries to store and retrieve secrets securely',
        command: 'npx',
        args: ['-y', '@takescake/1password-mcp'],
        envKeys: ['OP_SERVICE_ACCOUNT_TOKEN'],
        keyGetUrl: 'https://my.1password.com/settings/developer',
        keyGetLabel: 'Create a 1Password Service Account',
        dependency: 'npx -y @takescake/1password-mcp',
      },
    ],
  },
  {
    label: 'Monitoring & Uptime',
    icon: Activity,
    accent: 'text-orange-400',
    presets: [
      {
        label: 'Uptime Kuma',
        name: 'uptimekuma',
        description: 'Manage Uptime Kuma monitors, notifications and status pages (self-hosted)',
        command: 'npx',
        args: ['-y', '@davidfuchs/mcp-uptime-kuma'],
        envKeys: ['KUMA_URL', 'KUMA_USERNAME', 'KUMA_PASSWORD'],
        keyGetUrl: 'https://github.com/davidfuchs/mcp-uptime-kuma',
        keyGetLabel: 'KUMA_URL + login (2FA: use API key)',
        dependency: 'npx -y @davidfuchs/mcp-uptime-kuma',
      },
      {
        label: 'Better Stack Logs',
        name: 'betterstack',
        description: 'Monitor uptime and query live logs from Better Stack (LogTail)',
        command: 'npx',
        args: ['-y', '@blaze-money/betterstack-logs-mcp'],
        envKeys: ['BETTERSTACK_ACCESS_TOKEN'],
        keyGetUrl: 'https://betterstack.com',
        keyGetLabel: 'Get BETTERSTACK_ACCESS_TOKEN',
        dependency: 'npx -y @blaze-money/betterstack-logs-mcp',
      },
    ],
  },
  {
    label: 'Translation & Language',
    icon: Globe,
    accent: 'text-green-400',
    presets: [
      {
        label: 'DeepL',
        name: 'deepl',
        description: 'Accurate translations between dozens of languages with DeepL API',
        command: 'npx',
        args: ['-y', 'deepl-mcp-server'],
        envKeys: ['DEEPL_API_KEY'],
        keyGetUrl: 'https://www.deepl.com/pro-api',
        keyGetLabel: 'Get DEEPL_API_KEY',
        dependency: 'npx -y deepl-mcp-server',
      },
    ],
  },
  {
    label: 'Forms & Surveys',
    icon: MessageSquare,
    accent: 'text-sky-400',
    presets: [
      {
        label: 'Airtable',
        name: 'airtable',
        description: 'Read/write Airtable bases, tables, records and fields (official CLI)',
        command: 'npx',
        args: ['-y', '@airtable/mcp-cli'],
        envKeys: ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'],
        keyGetUrl: 'https://airtable.com/create/tokens',
        keyGetLabel: 'Get AIRTABLE_API_KEY',
        dependency: 'npx -y @airtable/mcp-cli',
      },
    ],
  },
  {
    label: 'Home & IoT',
    icon: Server,
    accent: 'text-blue-400',
    presets: [
      {
        label: 'Home Assistant',
        name: 'homeassistant',
        description: 'Control smart home devices — lights, switches, sensors, entities',
        command: 'npx',
        args: ['-y', 'home-assistant-mcp'],
        envKeys: ['HOME_ASSISTANT_URL', 'HOME_ASSISTANT_TOKEN'],
        keyGetLabel: 'Home Assistant URL + long-lived token',
        dependency: 'npx -y home-assistant-mcp',
      },
    ],
  },
  {
    label: 'Utilities & System',
    icon: Terminal,
    accent: 'text-slate-400',
    presets: [
      {
        label: 'System Info',
        name: 'system',
        description: 'Read CPU, RAM, disk, network and OS info from this machine (keyless)',
        command: 'npx',
        args: ['-y', 'mcp-system-info'],
        envKeys: [],
        dependency: 'npx -y mcp-system-info',
      },
      {
        label: 'Timezone',
        name: 'timezone',
        description: 'Resolve timezones, offsets and DST rules for any city (keyless)',
        command: 'npx',
        args: ['-y', '@mukundakatta/timezone-mcp'],
        envKeys: [],
        dependency: 'npx -y @mukundakatta/timezone-mcp',
      },
    ],
  },
  {
    label: 'Design & Creative',
    icon: Workflow,
    accent: 'text-pink-400',
    presets: [
      {
        label: 'Figma',
        name: 'figma',
        description: 'Read Figma files, frames and components via personal access token',
        command: 'npx',
        args: ['-y', 'figma-mcp-server'],
        envKeys: ['FIGMA_API_KEY'],
        keyGetUrl: 'https://www.figma.com/developers/api#access-tokens',
        keyGetLabel: 'Get FIGMA_API_KEY',
        dependency: 'npx -y figma-mcp-server',
      },
      {
        label: 'Recraft (AI Images)',
        name: 'recraft',
        description: "Generate and edit images from text prompts with Recraft image models",
        command: 'npx',
        args: ['-y', 'recraft-mcp-server'],
        envKeys: ['RECRAFT_API_KEY'],
        keyGetUrl: 'https://www.recraft.ai',
        keyGetLabel: 'Get RECRAFT_API_KEY',
        dependency: 'npx -y recraft-mcp-server',
      },
      {
        label: 'SEO Analyzer',
        name: 'seo',
        description: 'Analyze pages for SEO, accessibility and core web vitals (keyless)',
        command: 'npx',
        args: ['-y', 'seo-mcp-server'],
        envKeys: [],
        dependency: 'npx -y seo-mcp-server',
      },
    ],
  },
  {
    label: 'Shopping & Dining',
    icon: ShoppingBag,
    accent: 'text-emerald-400',
    presets: [
      {
        label: 'Amazon',
        name: 'amazon',
        description: 'Search and buy products across stores via the open-source amazon scraper (keyless)',
        command: 'uv',
        args: [
          'run',
          '--no-project',
          '--with',
          'amazon-mcp',
          '--with',
          'mcp<2',
          'python3',
          '-c',
          "from amazon_mcp.server import mcp; mcp.run(transport='stdio')",
        ],
        envKeys: [],
        dependency: 'uv run --no-project --with amazon-mcp (stdio; needs Python/uv)',
      },
      {
        label: 'Shopify',
        name: 'shopify',
        description: 'Manage a Shopify store — products, orders, customers, inventory via Admin API',
        command: 'npx',
        args: ['-y', '@ajackus/shopify-mcp-server'],
        envKeys: ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'],
        keyGetUrl: 'https://admin.shopify.com',
        keyGetLabel: 'Get SHOPIFY_STORE_DOMAIN + admin API token (Settings → Apps → Develop apps)',
        dependency: 'npx -y @ajackus/shopify-mcp-server',
      },
      {
        label: 'OpenTable',
        name: 'opentable',
        description: 'Search restaurants and check live table availability (keyless; read-only)',
        command: 'npx',
        args: ['-y', 'opentable-mcp'],
        envKeys: [],
        dependency: 'npx -y opentable-mcp (needs Node 20+ and Chrome)',
      },
    ],
  },
];

/** Icon/accent for a category label — reused when rendering the live stock catalog. */
const CATEGORY_ICONS: Record<string, { icon: LucideIcon; accent: string }> = Object.fromEntries(
  PRESET_CATEGORIES.map((c) => [c.label, { icon: c.icon, accent: c.accent }]),
);

/** Maps a backend stock entry onto the local Preset shape used by the add form. */
function stockEntryToPreset(e: McpStockEntryDto): Preset {
  return {
    label: e.label,
    name: e.name,
    description: e.description,
    transport: e.transport,
    command: e.command,
    args: e.args,
    envKeys: e.envKeys,
    url: e.url ?? undefined,
    keyGetUrl: e.keyGetUrl ?? undefined,
    keyGetLabel: e.keyGetLabel ?? undefined,
    dependency: e.dependency,
    remote: e.remote,
    manualOAuth: e.manualOAuth,
    oauthScopes: e.oauthScopes ?? undefined,
  };
}

/** Converts a server-side stock catalog to the local catalog shape. */
function stockToCatalog(stock: McpStockCatalogResponseDto): PresetCategory[] {
  return stock.categories.map((cat) => {
    const meta = CATEGORY_ICONS[cat.label] ?? { icon: Plug, accent: 'text-ink-muted' };
    return {
      label: cat.label,
      icon: meta.icon,
      accent: meta.accent,
      presets: cat.entries.map(stockEntryToPreset),
    };
  });
}

const IMPORT_EXAMPLE = JSON.stringify(
  {
    mcpServers: {
      example: {
        command: 'npx',
        args: ['-y', '@some/example-mcp'],
        env: { API_KEY: 'sk-…' },
      },
    },
  },
  null,
  2,
);

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
  'brave':     { Icon: SiBrave, color: 'text-[#FB542B]' },
  'google':    { Icon: SiGoogle, color: 'text-[#4285F4]' },
  'maps':      { Icon: SiGooglemaps, color: 'text-[#4285F4]' },
  'puppeteer': { Icon: SiBrave, color: 'text-[#00D084]' },
  'git-mcp':   { Icon: FaGithub, color: 'text-[#F05032]' },
  'typescript':{ Icon: SiTypescript, color: 'text-[#3178C6]' },
  'everything':{ Icon: TbApi, color: 'text-[#A855F7]' },
  'sequential':{ Icon: TbBrain, color: 'text-[#F59E0B]' },
  'mysql':     { Icon: SiMysql, color: 'text-[#4479A1]' },
  'mariadb':   { Icon: SiMariadb, color: 'text-[#003545]' },
  'minio':     { Icon: SiMinio, color: 'text-[#C72E49]' },
  's3':        { Icon: FaAws, color: 'text-[#FF9900]' },
  'grafana':   { Icon: SiGrafana, color: 'text-[#F46800]' },
  'prometheus':{ Icon: SiPrometheus, color: 'text-[#E6522C]' },
  'datadog':   { Icon: SiDatadog, color: 'text-[#632CA6]' },
  'mattermost':{ Icon: SiMattermost, color: 'text-[#0058CC]' },
  'huggingface': { Icon: SiHuggingface, color: 'text-[#FFD21E]' },
  'openai':    { Icon: Brain, color: 'text-[#10A37F]' },
  'hugging':   { Icon: SiHuggingface, color: 'text-[#FFD21E]' },
  'gdrive':    { Icon: SiGoogledrive, color: 'text-[#1AA260]' },
  'drive':     { Icon: SiGoogledrive, color: 'text-[#1AA260]' },
  'dropbox':   { Icon: FaDropbox, color: 'text-[#0061FF]' },
  'filesystem':{ Icon: TbFileCode, color: 'text-[#16A34A]' },
  'gmail':     { Icon: SiGmail, color: 'text-[#EA4335]' },
  'calendar':  { Icon: SiGooglecalendar, color: 'text-[#4285F4]' },
  'gcal':      { Icon: SiGooglecalendar, color: 'text-[#4285F4]' },
  'tavily':    { Icon: SiBrave, color: 'text-[#1F2937]' },
  'wikipedia': { Icon: Globe, color: 'text-[#636466]' },
  'arc':       { Icon: Code2, color: 'text-[#8B5CF6]' },
  'todoist':   { Icon: SiTodoist, color: 'text-[#E44332]' },
  'trello':    { Icon: TbBrandTrello, color: 'text-[#0079BF]' },
  'jupyter':   { Icon: SiJupyter, color: 'text-[#F37626]' },
  'youtube':   { Icon: SiYoutube, color: 'text-[#FF0000]' },
  'spotify':   { Icon: SiSpotify, color: 'text-[#1DB954]' },
  'stripe':    { Icon: SiStripe, color: 'text-[#635BFF]' },
  'auth0':     { Icon: SiAuth0, color: 'text-[#EB5424]' },
  '1password': { Icon: MdPassword, color: 'text-[#3B7DBD]' },
  'uptimekuma':{ Icon: Activity, color: 'text-[#1D3557]' },
  'betterstack': { Icon: Activity, color: 'text-[#05192D]' },
  'deepl':     { Icon: Globe, color: 'text-[#0F2B46]' },
  'airtable':  { Icon: SiAirtable, color: 'text-[#6437FF]' },
  'homeassistant': { Icon: SiHomeassistant, color: 'text-[#41BDF5]' },
  'system':    { Icon: Terminal, color: 'text-[#A7B6C2]' },
  'timezone':  { Icon: Globe, color: 'text-[#10B981]' },
  'figma':     { Icon: FaFigma, color: 'text-[#F24E1E]' },
  'recraft':   { Icon: MdDraw, color: 'text-[#7C3AED]' },
  'seo':       { Icon: Search, color: 'text-[#F97316]' },
  'terraform': { Icon: SiTerraform, color: 'text-[#844FBA]' },
  'kubernetes':{ Icon: SiKubernetes, color: 'text-[#326CE5]' },
  'amazon':   { Icon: FaAmazon, color: 'text-[#FF9900]' },
  'shopify':  { Icon: SiShopify, color: 'text-[#96BF48]' },
  'opentable':{ Icon: FaUtensils, color: 'text-[#DA3743]' },
};

function brandFor(name: string): { Icon: IconType; color: string } {
  const lower = name.toLowerCase();
  for (const key of Object.keys(BRAND_LOOKUP)) {
    if (lower.includes(key)) return BRAND_LOOKUP[key];
  }
  return { Icon: Plug, color: 'text-ink-muted' };
}

/**
 * Prefers an LLM/import-assigned `icon` (brand hint or emoji), then falls back
 * to the BRAND_LOOKUP match on the server name, then the generic Plug.
 */
function resolveServerIcon(name: string, icon: string | null | undefined): { Icon: IconType; color: string; glyph: string | null } {
  const raw = (icon ?? '').trim();
  if (raw) {
    const exactLower = raw.toLowerCase();
    if (BRAND_LOOKUP[exactLower]) {
      const b = BRAND_LOOKUP[exactLower];
      return { Icon: b.Icon, color: b.color, glyph: null };
    }
    const cp = Array.from(raw);
    if (cp.length >= 1 && cp.length <= 2 && /[\p{Emoji}]/u.test(raw)) {
      return { Icon: Plug, color: 'text-ink-muted', glyph: raw };
    }
  }
  const b = brandFor(name);
  return { Icon: b.Icon, color: b.color, glyph: null };
}

function categoryForServer(name: string, catalog: PresetCategory[]): { label: string; icon: LucideIcon; accent: string } {
  const lower = name.trim().toLowerCase();
  for (const cat of catalog) {
    for (const preset of cat.presets) {
      if (lower.includes(preset.name.toLowerCase())) {
        return { label: cat.label, icon: cat.icon, accent: cat.accent };
      }
    }
  }
  return { label: 'Other', icon: Plug, accent: 'text-ink-muted' };
}

/** Splits an args string into tokens, honoring "double-" and 'single-quoted' spans so
 *  presets with embedded spaces (e.g. `python3 -c "code …"`) survive the form round-trip. */
function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const tok = m[0];
    const q = tok[0];
    const len = tok.length;
    out.push(
      len >= 2 && (q === '"' || q === "'") ? tok.slice(1, len - 1) : tok,
    );
  }
  return out;
}

/** Joins an args array into an editable string, quoting spans that contain spaces or quotes. */
function joinArgs(args: string[]): string {
  return args
    .map((a) => (/[\s"']/.test(a) ? `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

export default function McpPage() {
  const toast = useToast();
  // Shared live store — every MCP-aware component mirrors this same list, so
  // adding/importing a server reflects everywhere without a hard reload.
  const { servers: liteServers, loading, refresh } = useMcpList();
  const servers = liteServers as unknown as McpServer[];
  const [stockCatalog, setStockCatalog] = useState<McpStockCatalogResponseDto | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showImportJson, setShowImportJson] = useState(false);
  const [catalogExpanded, setCatalogExpanded] = useState<Record<string, boolean>>({});
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; skipped: Array<{ name: string; reason: string }>; errors: string[] } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; tools?: number; error?: string } | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formTags, setFormTags] = useState('');
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
  const [tokenPromptServer, setTokenPromptServer] = useState<McpServer | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const oauthRef = useRef<HTMLDivElement>(null);
  const catalogScrollRef = useRef<HTMLDivElement>(null);

  // Refetch shared store after any mutation so the MCP page + chat stay in sync.
  const reloadServers = useCallback(() => { void refresh(); }, [refresh]);

  // Load the canonical server-side stock catalog (189 servers) so the "pick a
  // preset" catalogue always matches the backend. Falls back to the local
  // hardcoded presets if the endpoint is unavailable.
  useEffect(() => {
    let cancelled = false;
    api
      .listMcpStockCatalog()
      .then((res) => {
        if (!cancelled) setStockCatalog(res);
      })
      .catch(() => {
        if (!cancelled) setStockCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const catalog: PresetCategory[] = useMemo(
    () => (stockCatalog && stockCatalog.categories.length > 0 ? stockToCatalog(stockCatalog) : PRESET_CATEGORIES),
    [stockCatalog],
  );
  const totalPresets = useMemo(() => catalog.reduce((n, c) => n + c.presets.length, 0), [catalog]);

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) return toast.error('Name is required');
    if (name.length < 2) return toast.error('Name must be at least 2 characters');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_ ]*$/.test(name)) return toast.error('Name can only contain letters, numbers, dashes and spaces');
    if (!formCategory.trim()) return toast.error('Category is required — pick one so the agent can find this server by category');
    if (isConfigured(name)) {
      toast.error(`"${name}" is already configured`);
      return;
    }
    if (formTransport === 'http') {
      const url = formUrl.trim();
      if (!url) return toast.error('URL is required for remote HTTP servers');
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return toast.error('URL must be a valid absolute URL (e.g. https://mcp.example.com)');
      }
      if (!/^https?:$/.test(parsedUrl.protocol)) return toast.error('URL must use http:// or https://');
      if (formManualOAuth && !formOauthClientId.trim()) return toast.error('OAuth Client ID is required when manual OAuth is enabled');
    } else {
      if (!formCommand.trim()) return toast.error('Command is required');
      if (!/^[\w.\-\/@]+$/.test(formCommand.trim())) return toast.error('Command contains invalid characters');
    }
    // Validate env key format for every non-empty pair.
    for (const pair of formEnv) {
      const key = pair.key.trim();
      const value = pair.value.trim();
      if (!key) continue;
      if (value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return toast.error(`Invalid env variable name "${key}" — letters, digits and underscore only`);
      }
      if (!value) return toast.error(`Env variable "${key}" needs a value`);
    }
    setSaving(true);
    try {
      const args = formArgs.trim() ? splitArgs(formArgs) : [];
      const env: Record<string, string> = {};
      for (const pair of formEnv) {
        if (pair.key.trim() && pair.value.trim()) env[pair.key.trim()] = pair.value.trim();
      }
      const res = await api.createMcpServer({
        name,
        description: formDesc.trim(),
        category: formCategory.trim(),
        tags: formTags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
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
      toast.success(`MCP server "${name}" created`);
      const test = res.test;
      if (test?.ok) {
        toast.success(`Connected — ${test.tools} tool${test.tools === 1 ? '' : 's'} ready, status set to On`);
      } else if (test?.needsOAuth) {
        toast.info('Server added — complete OAuth to connect');
      } else {
        toast.error(`Connection failed: ${test?.error ?? 'unknown error'} — fix the config or add credentials`);
      }
      toast.info('System prompt will refresh on the next agent run');
      setShowAddForm(false);
      setShowFormModal(false);
      setFormName(''); setFormDesc(''); setFormCommand('npx'); setFormArgs(''); setFormEnv([]);
      setFormTransport('stdio'); setFormUrl(''); setFormCategory(''); setFormTags('');
      setFormManualOAuth(false); setFormOauthClientId(''); setFormOauthClientSecret(''); setFormOauthScopes('');
      reloadServers();
    } catch (err) {
      toast.error('Failed to create MCP server');
    } finally {
      setSaving(false);
    }
  };

  const importMcp = async () => {
    if (!importText.trim()) return toast.error('Paste JSON first');
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      toast.error('Invalid JSON — check the syntax');
      return;
    }
    setImporting(true);
    try {
      const res = await api.importMcpServers(parsed);
      const skipped = (res.skipped ?? []).map((s) => s as { name: string; reason: string });
      const errors = (res.errors ?? []) as string[];
      setImportResult({ created: (res.created ?? []).length, skipped, errors });
      if (errors.length === 0) {
        toast.success(
          (res.created?.length ?? 0) > 0
            ? `Imported ${res.created!.length} MCP server${res.created!.length === 1 ? '' : 's'}`
            : 'Nothing new to import',
        );
        toast.info('System prompt will refresh on the next agent run');
        setImportText('');
        setShowImportJson(false);
      }
      reloadServers();
    } catch {
      toast.error('Import failed — payload rejected');
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete MCP server "${name}"?`)) return;
    setDeletingId(id);
    try {
      await api.deleteMcpServer(id);
      toast.success(`Deleted "${name}"`);
      reloadServers();
    } catch {
      toast.error('Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    setTogglingId(id);
    try {
      await api.updateMcpServer(id, { enabled });
      reloadServers();
    } catch {
      toast.error('Failed to toggle');
    } finally {
      setTogglingId(null);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const res = await api.testMcpServer(id);
      setTestResult({ id, ok: res.ok, tools: res.tools?.length, error: res.error });
      if (res.ok) {
        await api.updateMcpServer(id, { enabled: true });
        toast.success('Connection OK — status set to On');
        reloadServers();
      }
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
          reloadServers();
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'OAuth connect failed';
      // No DCR + no user-supplied client → offer the personal-access-token path
      // (Render, Cloudflare-class servers) instead of a dead-end error.
      if (
        msg.includes('does not support automatic client registration') ||
        msg.includes('consumer credentials') ||
        msg.includes('needs your own') ||
        msg.includes('OAuth not supported by') ||
        msg.includes('no resource metadata')
      ) {
        setTokenPromptServer(srv);
      } else {
        toast.error(`OAuth connect failed: ${msg}`);
      }
    } finally {
      setOauthConnecting(null);
      setOauthPolling(null);
    }
  };

  const handleOAuthDisconnect = async (srv: McpServer) => {
    try {
      await api.disconnectMcpOAuth(srv.id);
      toast.success(`Disconnected ${srv.name}`);
      reloadServers();
    } catch {
      toast.error('Disconnect failed');
    }
  };

  const configuredNames = useMemo(() => new Set(servers.map((s) => s.name.trim().toLowerCase())), [servers]);

  const groupedServers = useMemo(() => {
    const byCat = new Map<string, { label: string; icon: LucideIcon; accent: string; servers: McpServer[] }>();
    for (const srv of servers) {
      const derived = srv.category?.trim() ? { label: srv.category, icon: Plug, accent: 'text-ink-muted' } : categoryForServer(srv.name, catalog);
      const { label, icon, accent } = derived;
      const group = byCat.get(label);
      if (group) {
        group.servers.push(srv);
      } else {
        byCat.set(label, { label, icon, accent, servers: [srv] });
      }
    }
    return Array.from(byCat.values());
  }, [servers]);

  const toggleCat = (label: string) =>
    setCollapsedCats((prev) => ({ ...prev, [label]: !prev[label] }));
  const toggleCatalogCat = (label: string) =>
    setCatalogExpanded((prev) => ({ ...prev, [label]: !prev[label] }));

  const filteredCategories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let cats = catalog;
    if (activeCategory !== 'All') {
      cats = cats.filter((c) => c.label === activeCategory);
    }
    if (q) {
      cats = cats
        .map((cat) => ({
          ...cat,
          presets: cat.presets.filter(
            (p) =>
              p.label.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q) ||
              p.description.toLowerCase().includes(q) ||
              p.dependency.toLowerCase().includes(q),
          ),
        }))
        .filter((cat) => cat.presets.length > 0);
    }
    return cats;
  }, [searchQuery, activeCategory, catalog]);

  const filteredResults = filteredCategories.reduce((n, c) => n + c.presets.length, 0);

  const isConfigured = (name: string) => configuredNames.has(name.trim().toLowerCase());

  const applyPreset = (sample: Preset) => {
    if (isConfigured(sample.name)) {
      toast.error(`"${sample.name}" is already configured`);
      return;
    }
    const ownerCat = catalog.find((c) => c.presets.some((pp) => pp.name === sample.name));
    const isRemote = sample.remote || sample.transport === 'http';
    setFormName(sample.name);
    setFormDesc(sample.description);
    setFormCategory(ownerCat?.label ?? '');
    setFormTags('');
    setFormTransport(isRemote ? 'http' : 'stdio');
    setFormUrl(sample.url ?? '');
    setFormCommand(sample.command || 'npx');
    setFormArgs(joinArgs(sample.args));
    setFormEnv(sample.envKeys.map((k) => ({ key: k, value: '' })));
    setFormManualOAuth(!!sample.manualOAuth);
    setFormOauthClientId('');
    setFormOauthClientSecret('');
    setFormOauthScopes(sample.oauthScopes ?? '');
    setShowAddForm(true);
    setShowFormModal(true);
  };

  const openCustomForm = () => {
    setFormName('');
    setFormDesc('');
    setFormCategory('');
    setFormTags('');
    setFormCommand('npx');
    setFormArgs('');
    setFormEnv([]);
    setFormTransport('stdio');
    setFormUrl('');
    setFormManualOAuth(false);
    setFormOauthClientId('');
    setFormOauthClientSecret('');
    setFormOauthScopes('');
    setShowAddForm(true);
    setShowFormModal(true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-5 pb-20 sm:px-6 sm:py-6">
      <PageHeader
        title="MCP Servers"
        description="Connect external Model Context Protocol servers to give the agent access to more tools (max 3 active at once)."
      />

        {/* Header row with action */}
        <div className="mb-6 mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {showAddForm ? (
              <h2 className="text-sm font-semibold text-slate-300">
                Configure new server
              </h2>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(true);
                  setShowImportJson(false);
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-500/20 transition-all hover:shadow-violet-500/40 hover:brightness-110 active:scale-95"
              >
                <Plus className="h-4 w-4" />
                Add MCP Server
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setShowImportJson((v) => !v);
                if (showAddForm) setShowAddForm(false);
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:border-violet-500/50 hover:bg-slate-900 active:scale-95"
            >
              <FileJson className="h-4 w-4" />
              Import JSON
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-ink-muted">Configured servers</span>
            <span className="rounded-full bg-surface-800 px-2 py-0.5 text-xs font-semibold text-white">{servers.length}</span>
          </div>
        </div>

        {/* Import JSON panel */}
        {showImportJson && (
          <div className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-card-lift backdrop-blur-md">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Import MCP servers from JSON</h3>
              <button
                type="button"
                onClick={() => {
                  setShowImportJson(false);
                  setImportResult(null);
                }}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-slate-400">
              Paste Claude-Desktop style <code className="rounded bg-slate-800 px-1 py-0.5 text-[11px] text-cyan-300">mcpServers</code> map,
              a <code className="rounded bg-slate-800 px-1 py-0.5 text-[11px] text-cyan-300">servers</code> array, or a single server
              object. Entries are validated against a safe-runner allowlist (no shell metacharacters); duplicates are skipped and
              nothing is overwritten.
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
              rows={9}
              placeholder={IMPORT_EXAMPLE}
              className="w-full resize-y rounded-lg border border-slate-700/60 bg-slate-950/80 p-3 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={importMcp}
                  disabled={importing}
                  className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-violet-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileJson className="h-4 w-4" />}
                  {importing ? 'Validating & importing…' : 'Validate & Import'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImportText('');
                    setImportResult(null);
                  }}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Clear
                </button>
              </div>
            </div>
            {importResult && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-slate-300">
                  <span className="font-semibold text-emerald-300">{importResult.created}</span> created
                  {importResult.skipped.length > 0 && (
                    <span>
                      {' '}
                      · <span className="font-semibold text-yellow-300">{importResult.skipped.length}</span> skipped (already exist —
                      not overwritten)
                    </span>
                  )}
                  {importResult.errors.length > 0 && (
                    <span>
                      {' '}
                      · <span className="font-semibold text-rose-300">{importResult.errors.length}</span> errors
                    </span>
                  )}
                </p>
                {importResult.errors.length > 0 && (
                  <div className="max-h-32 overflow-y-auto rounded-lg border border-rose-500/30 bg-rose-500/5 p-2">
                    {importResult.errors.map((e, i) => (
                      <p key={i} className="font-mono text-[11px] leading-relaxed text-rose-300">
                        {e}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Add form */}
        {showAddForm && (
          <div className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-card-lift backdrop-blur-md">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Add MCP Server</h3>
              <button type="button" onClick={() => setShowAddForm(false)} className="text-slate-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Preset catalog */}
            <div className="mb-4">
              <div className="mb-3 flex flex-col gap-3">
                {/* Search */}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search MCP servers, services or install commands…"
                    className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 py-2 pl-9 pr-8 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-white"
                      aria-label="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {/* Category filter chips */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {[{ label: 'All', icon: Search }, ...catalog.map((c) => ({ label: c.label, icon: c.icon }))].map((f) => {
                    const Icon = f.icon;
                    const active = activeCategory === f.label;
                    return (
                      <button
                        key={f.label}
                        type="button"
                        onClick={() => setActiveCategory(f.label)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-all',
                          active
                            ? 'border-violet-500/60 bg-violet-500/15 text-white shadow-[0_0_12px_rgba(139,92,246,0.25)]'
                            : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-600 hover:text-slate-200',
                        )}
                      >
                        <Icon className="h-3 w-3" />
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Catalogue — {filteredResults} of {totalPresets} presets across {catalog.length} categories. Pick one to prefill.
              </p>
              {filteredResults === 0 && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-3">
                  <p className="text-xs text-slate-400">No presets match your search.</p>
                  <button
                    type="button"
                    onClick={openCustomForm}
                    className="text-xs font-medium text-violet-400 hover:text-violet-300"
                  >
                    Configure custom server →
                  </button>
                </div>
              )}
              <div ref={catalogScrollRef} className="max-h-[420px] overflow-y-auto pr-1">
                <div className="space-y-3">
                {filteredCategories.map((cat) => {
                  const CatIcon = cat.icon;
                  const searching = searchQuery.trim().length > 0;
                  const expanded = activeCategory !== 'All' || searching || !!catalogExpanded[cat.label];
                  return (
                    <div key={cat.label} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
                      <button
                        type="button"
                        onClick={() => toggleCatalogCat(cat.label)}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-800/40"
                      >
                        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-800', cat.accent)}>
                          <CatIcon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-xs font-semibold text-slate-200">{cat.label}</span>
                        <span className="shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                          {cat.presets.length}
                        </span>
                        <ChevronRight
                          className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-150', expanded && 'rotate-90')}
                        />
                      </button>

                      {expanded && (
                        <div className="border-t border-slate-800/60 p-3">
                          <div className="grid gap-2.5 sm:grid-cols-2">
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
                                  'flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors',
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
                                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-800', brandColor)}>
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
                                <span className="block text-[11px] leading-snug text-slate-400">{p.description}</span>
                                <span className="mt-auto flex flex-wrap items-center gap-1.5">
                                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500">{p.dependency}</span>
                                  {p.envKeys.length > 0 && (
                                    <span className="flex flex-wrap items-center gap-1">
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
                                </span>
                              </button>
                            );
                          })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              </div>
            </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500">Don't see your server? Configure it manually.</p>
                <button
                  type="button"
                  onClick={openCustomForm}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-violet-500/50 hover:text-white"
                >
                  <Settings2 className="h-3.5 w-3.5 text-violet-400" />
                  Configure custom server
                </button>
              </div>
          </div>
        )}

        {/* Add MCP Server modal form */}
        {showFormModal && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
            onClick={() => setShowFormModal(false)}
          >
            <div
              className="my-auto w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl backdrop-blur-md"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">Add MCP Server</h3>
                  <p className="text-[11px] text-slate-500">Fill in the details below, then save.</p>
                </div>
                <button type="button" onClick={() => setShowFormModal(false)} className="text-slate-400 transition-colors hover:text-white">
                  <X className="h-4 w-4" />
                </button>
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
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Category *</label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                >
                  <option value="">— choose a category —</option>
                  {catalog.map((c) => (
                    <option key={c.label} value={c.label}>{c.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">Required — the agent searches MCP servers by category, so every server must belong to one.</p>
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Tags (optional)</label>
                <input
                  value={formTags}
                  onChange={(e) => setFormTags(e.target.value)}
                  placeholder="comma-separated aliases, e.g. restaurant, menu, delivery"
                  className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
                <p className="mt-1 text-[11px] text-slate-500">Keywords the agent searches on — helps it find this server when the task uses different words.</p>
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
                  <p className="mt-1 text-[11px] text-slate-500">No command required. Public servers connect automatically after saving; servers that need auth will prompt you to complete OAuth.</p>
                  {formManualOAuth && (
                    <div ref={oauthRef}>
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
                          <p className="mt-1 text-[11px] text-slate-400">
                            {formUrl.includes('googleapis.') ? (
                              <>Google-hosted servers need an OAuth client you create once in Google Cloud.</>
                            ) : (
                              <>This server does not support automatic client registration — provide your own OAuth client below.</>
                            )}
                          </p>
                          <details className="group mt-2 rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] font-medium text-cyan-300 hover:text-cyan-200">
                              Where do I get these credentials?
                            </summary>
                            {formUrl.includes('googleapis.') ? (
                              <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-300">
                                <p>
                                  <span className="font-medium text-slate-100">1.</span> Create a project (any name) in Google Cloud Console:
                                </p>
                                <a
                                  href="https://console.cloud.google.com/apis/credentials"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block w-fit text-cyan-300 underline"
                                >
                                  console.cloud.google.com/apis/credentials
                                </a>
                                <p>
                                  <span className="font-medium text-slate-100">2.</span> In &quot;OAuth consent screen&quot; → create an app (User type: External), add your Gmail as a test user, save. Then under &quot;Credentials&quot; click{' '}
                                  <span className="text-slate-100">Create Credentials → OAuth client ID</span>.
                                </p>
                                <p>
                                  <span className="font-medium text-slate-100">3.</span> Choose <span className="text-slate-100">Web application</span> and add this as an{' '}
                                  <span className="text-slate-100">Authorized redirect URI</span>:
                                </p>
                                <code className="block rounded bg-slate-800/80 px-2 py-1 text-cyan-300">http://127.0.0.1:8642/api/mcp/oauth/callback</code>
                                <p>
                                  <span className="font-medium text-slate-100">4.</span> Copy the <span className="text-slate-100">Client ID</span> and{' '}
                                  <span className="text-slate-100">Client Secret</span> into the fields above and save.
                                </p>
                                <p className="text-slate-400">
                                  Prefer fewer secrets? Create a <span className="text-slate-100">Desktop app</span> client instead — Google accepts the Client ID alone (no secret) with the same redirect.
                                </p>
                                <p className="text-slate-400">
                                  The first login may warn &quot;Google hasn't verified this app&quot; — it is your own client, so click{' '}
                                  <span className="text-slate-100">Advanced → Continue (unsafe)</span>, then sign in.
                                </p>
                              </div>
                            ) : (
                              <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-300">
                                <p>
                                  This server publishes no OAuth discovery metadata, so it needs a client you already own from its provider. Check the provider&apos;s docs for its OAuth client setup; enter the Client ID and, if the provider issues one, the Client Secret.
                                </p>
                              </div>
                            )}
                          </details>
                        </div>
                      </div>
                    </div>
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
                onClick={() => setShowFormModal(false)}
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
          <div className="pb-6">
            {groupedServers.map((group) => {
              const collapsed = !!collapsedCats[group.label];
              const GroupIcon = group.icon;
              return (
                <div key={group.label} className="border-b border-slate-800/60 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => toggleCat(group.label)}
                    className="flex w-full items-center gap-2 py-2.5 text-left transition-colors hover:bg-surface-800/40"
                  >
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-150',
                        !collapsed && 'rotate-90',
                      )}
                    />
                    <GroupIcon className={cn('h-3.5 w-3.5 shrink-0', group.accent)} />
                    <span className="text-sm font-medium text-slate-200">{group.label}</span>
                    <span className="ml-auto rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                      {group.servers.length}
                    </span>
                  </button>

                  {!collapsed && (
                    <div className="ml-[18px] border-l border-slate-800/60">
                      {group.servers.map((srv) => (
                        <div
                          key={srv.id}
                          className={cn(
                            'px-3 py-2.5 transition-colors hover:bg-surface-800/40',
                            !srv.enabled && 'opacity-60',
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2.5">
                              {isApify(srv.name) ? (
                                <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                                  <ApifyIcon className="h-4 w-4 text-[#F9AA25] drop-shadow-[0_0_8px_rgba(249,170,37,0.6)]" />
                                </div>
                              ) : (
                                <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                                  {(() => {
                                    const { Icon: BrandIcon, color: brandColor, glyph } = resolveServerIcon(srv.name, srv.icon);
                                    if (glyph) return <span className="text-sm leading-none">{glyph}</span>;
                                    return <BrandIcon className={cn('h-3.5 w-3.5', brandColor)} />;
                                  })()}
                                </div>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <h4 className="truncate text-sm font-medium text-white">{srv.name}</h4>
                                  {srv.transport === 'http' && (
                                    <span
                                      className={cn(
                                        'shrink-0 rounded px-1 py-0.5 text-[9px] font-medium leading-none',
                                        srv.oauthConnected
                                          ? 'bg-emerald-500/15 text-emerald-300'
                                          : 'bg-sky-500/15 text-sky-300',
                                      )}
                                    >
                                      {srv.oauthConnected ? 'OAuth' : 'Remote'}
                                    </span>
                                  )}
                                  {!srv.enabled && (
                                    <span className="shrink-0 rounded bg-slate-800 px-1 py-0.5 text-[9px] leading-none text-slate-400">
                                      disabled
                                    </span>
                                  )}
                                </div>
                                <p
                                  className={cn(
                                    'mt-0.5 truncate text-[11px]',
                                    srv.description ? 'text-ink-muted/70' : 'font-mono text-ink-muted/60',
                                  )}
                                >
                                  {srv.description ||
                                    (srv.transport === 'http'
                                      ? (srv.url ?? 'http')
                                      : `${srv.command} ${(srv.args ?? []).join(' ')}`)}
                                </p>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-0.5">
                              {srv.transport === 'http' ? (
                                srv.oauthConnected ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleTest(srv.id)}
                                      disabled={testingId === srv.id}
                                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
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
                                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                                      title="Disconnect OAuth"
                                    >
                                      <PowerOff className="h-3 w-3" />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleTest(srv.id)}
                                    disabled={testingId === srv.id}
                                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
                                    title={srv.oauthConnected ? 'Test connection' : 'Public server — no credentials needed'}
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
                                )
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleTest(srv.id)}
                                    disabled={testingId === srv.id}
                                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
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
                                    onClick={() => handleToggle(srv.id, !srv.enabled)}
                                    disabled={togglingId === srv.id}
                                    className={cn(
                                      'inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50',
                                      srv.enabled
                                        ? 'text-emerald-300 hover:bg-emerald-500/15'
                                        : 'text-slate-400 hover:bg-white/5 hover:text-white',
                                    )}
                                    title={srv.enabled ? 'Disable server' : 'Enable server'}
                                  >
                                    {togglingId === srv.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : srv.enabled ? (
                                      <Power className="h-3 w-3" />
                                    ) : (
                                      <PowerOff className="h-3 w-3" />
                                    )}
                                    {togglingId === srv.id ? '…' : srv.enabled ? 'On' : 'Off'}
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDelete(srv.id, srv.name)}
                                disabled={deletingId === srv.id}
                                className="inline-flex items-center rounded-lg px-2 py-1.5 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                                title="Delete server"
                              >
                                {deletingId === srv.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                              </button>
                            </div>
                          </div>

                          {testResult?.id === srv.id && testResult.error && (
                            <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
                              {testResult.error}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Max 3 hint */}
            <p className="mt-3 text-center text-xs text-slate-500">
              Max 3 MCP servers can be active at once during an agent run.
            </p>
          </div>
        )}
        </div>
      </div>
      <McpTokenDialog
        open={!!tokenPromptServer}
        server={tokenPromptServer ? { id: tokenPromptServer.id, name: tokenPromptServer.name, url: tokenPromptServer.url } : null}
        onClose={() => setTokenPromptServer(null)}
        onSaved={() => reloadServers()}
      />
    </div>
  );
}
