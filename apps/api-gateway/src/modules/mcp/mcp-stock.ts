/**
 * MCP STOCK CATALOG — the universe of MCP servers Smoke Monkey knows about.
 *
 * This is the canonical "stock" list: servers the user CAN connect, grouped
 * into categories, complementing the servers that are already configured
 * (stored in user_mcp_servers). It feeds:
 *   - the inspect_mcp_stock tool (shows added + not-yet-added stock together,
 *     filterable by category / regex)
 *   - the MCP SERVERS system-prompt block (unique category list + stock counts)
 *
 * The `name` is the stable identifier used to match a stock entry against a
 * configured server (by lowercase name) so a stock item flips to "added".
 * `icon` is an optional brand hint (emoji / brand slug) matched by the UI's
 * brand resolver; when absent the UI falls back to the name.
 *
 * `description` is the agent-facing USE-CASE hint (~15 words): what the server
 * does + an "activate when …" trigger, so the agent knows which mcp_<id> to
 * activate while looping. Keep it short and activation-focused.
 */

export interface McpStockEntry {
  name: string;
  label: string;
  description: string;
  category: string;
  tags: string[];
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  envKeys: string[];
  url: string | null;
  icon: string | null;
  keyGetUrl: string | null;
  keyGetLabel: string | null;
  dependency: string;
  remote: boolean;
  manualOAuth: boolean;
  oauthScopes: string | null;
}

export interface McpStockCategory {
  label: string;
  entries: McpStockEntry[];
}

/**
 * Curated search tags per stock server. These are ALIASES a task might use
 * that the server's name/description words don't literally contain (e.g. a
 * "restaurant detail/inner page UI" task → tags ["food","delivery","restaurant",
 * "menu"] on a browser server). They extend the inspect_mcp_stock grep/recommend
 * haystack so natural-language capability queries still find the right tool.
 * Lowercase, singular; kept short (2-6 per server).
 */
const TAGS_BY_NAME: Record<string, string[]> = {
  'playwright-mcp': ['browser', 'e2e', 'ui', 'screenshot', 'html'],
  puppeteer: ['browser', 'e2e', 'screenshot', 'scrape', 'pdf'],
  'chrome-devtools': ['browser', 'debug', 'dom', 'automation'],
  browserbase: ['browser', 'cloud', 'screenshot', 'headless'],
  'mcp-server-fetch': ['browser', 'url', 'webpage', 'markdown'],
  'mcp-server-firecrawl': ['crawl', 'scrape', 'extract', 'web'],
  apify: ['scrape', 'crawl', 'automation', 'actors'],
  'mcp-exa': ['semantic', 'research', 'web', 'code'],
  'google-maps': ['location', 'geo', 'places', 'directions'],
  'github-mcp-server': ['repo', 'code', 'pr', 'pull-request', 'issues'],
  'gitlab-mcp-server': ['repo', 'merge-request', 'pipeline', 'ci'],
  'git-mcp': ['git', 'commit', 'branch', 'repo'],
  'postgres-mcp-server': ['sql', 'database', 'rdbms'],
  'mysql-mcp-server': ['sql', 'database', 'rdbms', 'maria'],
  'sqlite-mcp-server': ['sql', 'database', 'local'],
  'mcp-server-sqlite': ['sql', 'database', 'local'],
  redis: ['cache', 'queue'],
  'redis-mcp-server': ['cache', 'queue'],
  mongodb: ['nosql', 'crud', 'documents'],
  'mongodb-atlas': ['nosql', 'crud', 'documents', 'cloud'],
  dynamodb: ['aws', 'nosql', 'cloud'],
  neo4j: ['graph', 'cypher'],
  elasticsearch: ['search', 'index'],
  clickhouse: ['olap', 'analytics', 'sql'],
  excalidraw: ['whiteboard', 'sketch', 'diagram'],
  mermaid: ['diagram', 'flowchart', 'markdown'],
  plantuml: ['uml', 'diagram', 'sequence'],
  drawio: ['diagram', 'mxgraph', 'whiteboard'],
  miro: ['whiteboard', 'collaboration', 'board'],
  lucid: ['diagram', 'flowchart', 'whiteboard'],
  'pdf-generation': ['pdf', 'document', 'report'],
  'mcp-pdf': ['pdf', 'document'],
  'excel-gen': ['excel', 'xlsx', 'spreadsheet'],
  'excel-mcp': ['excel', 'xlsx', 'spreadsheet'],
  'pptx-gen': ['ppt', 'pptx', 'slide', 'presentation'],
  'powerpoint-mcp': ['ppt', 'pptx', 'slide', 'presentation'],
  'mcp-slides': ['ppt', 'pptx', 'slide', 'presentation'],
  gmail: ['email', 'mail', 'inbox'],
  'gmail-mcp': ['email', 'mail', 'inbox'],
  slack: ['chat', 'message', 'team'],
  'slack-mcp': ['chat', 'message', 'team'],
  whatsapp: ['chat', 'message', 'phone'],
  'whatsapp-mcp': ['chat', 'message', 'phone'],
  notion: ['notes', 'workspace', 'docs'],
  'notion-mcp': ['notes', 'workspace', 'docs'],
  linear: ['issue', 'ticket', 'pm'],
  jira: ['issue', 'ticket', 'project'],
  'jira-mcp': ['issue', 'ticket', 'project'],
  trello: ['board', 'kanban', 'task'],
  'sentiment-mcp': ['nlp', 'analysis', 'emotion'],
  huggingface: ['ml', 'inference', 'transformers'],
  'hugging-face': ['ml', 'inference', 'transformers'],
  'ml-mcp': ['ml', 'model', 'inference'],
  'search-openai': ['search', 'web', 'gpt'],
  tavily: ['search', 'web', 'research'],
  'tavily-mcp': ['search', 'web', 'research'],
  'brave-search': ['search', 'web'],
  'google-search': ['search', 'web'],
  searxng: ['search', 'web', 'metasearch'],
  duckduckgo: ['search', 'web', 'anonymous'],
  composer: ['music', 'audio', 'mix'],
  'music-gen': ['music', 'audio', 'audio-generation'],
  'suno-mcp': ['music', 'audio', 'song'],
  'elevenlabs-mcp': ['tts', 'voice', 'speech', 'audio'],
  'tts-mcp': ['tts', 'speech', 'voice', 'audio'],
  'speech-to-text-mcp': ['stt', 'transcribe', 'audio'],
  'livekit-mcp': ['voice', 'call', 'audio', 'realtime'],
  'camera-mcp': ['photo', 'capture', 'vision'],
  'video-editing-mcp': ['video', 'edit', 'ffmpeg'],
  'media-mcp': ['video', 'audio', 'media', 'ffmpeg'],
  'image-gen': ['image', 'generate', 'diffusion'],
  'img-api': ['image', 'edit', 'resize'],
  'blender-mcp': ['3d', 'model', 'render'],
  'pygame-mcp': ['game', '2d', 'gaming'],
  'google-sheets-mcp': ['spreadsheet', 'sheets', 'excel'],
  airtable: ['database', 'tables', 'nocode'],
  'airtable-mcp': ['database', 'tables', 'nocode'],
  supabase: ['database', 'postgres', 'backend', 'auth'],
  'graphql-mcp': ['graphql', 'api', 'query'],
  'rest-api-mcp': ['api', 'rest', 'http'],
  'fetch-mcp': ['api', 'http', 'network'],
  'mcp-browser-utils': ['browser', 'screenshot', 'web'],
  'youtube-mcp': ['video', 'youtube', 'content'],
  'youtube-toolkit': ['video', 'youtube', 'transcript'],
  shadcn: ['component', 'ui', 'registry', 'react'],
  'shadcn-studio': ['component', 'ui', 'react', 'registry'],
  magicui: ['component', 'ui', 'animation', 'registry', 'react'],
  '21st': ['component', 'ui', 'generate', 'frontend', 'react'],
  vuetify: ['component', 'ui', 'vue', 'material'],
  'ui-skills': ['ui', 'skill', 'design', 'registry', 'frontend'],
  iconify: ['icon', 'svg', 'library', 'iconify'],
  'mcp-universal-icons': ['icon', 'svg', 'tailwind', 'lucide'],
  'lucide-icons': ['icon', 'svg', 'lucide'],
  v0: ['ui', 'generate', 'frontend', 'vercel', 'ai'],
  'next-devtools': ['nextjs', 'debug', 'runtime', 'routes', 'errors'],
  mui: ['component', 'ui', 'material', 'react'],
  antd: ['component', 'ui', 'react', 'enterprise'],
  'chakra-ui': ['component', 'ui', 'react', 'tokens'],
  mantine: ['component', 'ui', 'react'],
  tailwindcss: ['tailwind', 'css', 'styling', 'utility'],
  'shadcn-ui': ['component', 'ui', 'react', 'svelte', 'vue', 'blocks'],
  'agent-skills-backend': ['skill', 'workflow', 'backend', 'api', 'security', 'tdd', 'spec'],
  'agent-skills-frontend': ['skill', 'workflow', 'frontend', 'ui', 'browser', 'perf'],
  'agent-skills-devops': ['skill', 'workflow', 'devops', 'deploy', 'ci', 'cd', 'ship', 'migration'],
  'agent-skills-qa': ['skill', 'workflow', 'qa', 'testing', 'review', 'debug', 'quality'],
};

function entry(
  e: Partial<McpStockEntry> & { name: string; label: string; description: string; category: string },
  url: string | null = null,
  icon: string | null = null,
): McpStockEntry {
  const transport = e.transport ?? (url ? 'http' : 'stdio');
  return {
    name: e.name,
    label: e.label,
    description: e.description,
    category: e.category,
    tags: e.tags ?? TAGS_BY_NAME[e.name] ?? [],
    transport,
    command: e.command ?? '',
    args: e.args ?? [],
    envKeys: e.envKeys ?? [],
    url,
    icon,
    keyGetUrl: e.keyGetUrl ?? null,
    keyGetLabel: e.keyGetLabel ?? null,
    dependency: e.dependency ?? '',
    remote: e.remote ?? false,
    manualOAuth: e.manualOAuth ?? false,
    oauthScopes: e.oauthScopes ?? null,
  };
}

export const MCP_STOCK_CATEGORIES: McpStockCategory[] = [
  {
    label: "Whiteboards & Flowcharts",
    entries: [
      entry({ name: "excalidraw", label: "Excalidraw", description: "Whiteboard scenes from Mermaid syntax with live preview — activate when sketching hand-drawn diagrams.", category: "Whiteboards & Flowcharts", transport: undefined, command: "npx", args: ["-y","mcp-excalidraw"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y mcp-excalidraw", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mermaid", label: "Mermaid", description: "Flowcharts, sequence, gantt, class, state diagrams from markdown text — activate when diagramming in markdown.", category: "Whiteboards & Flowcharts", transport: undefined, command: "npx", args: ["-y","mcp-mermaid@latest"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y mcp-mermaid@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "plantuml", label: "PlantUML", description: "UML sequence, class, activity, component diagrams from simple text — activate when creating UML diagrams.", category: "Whiteboards & Flowcharts", transport: undefined, command: "npx", args: ["-y","plantuml-mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y plantuml-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "drawio", label: "draw.io", description: "Create and manage draw.io diagrams via mxGraph — activate when editing draw.io diagram files.", category: "Whiteboards & Flowcharts", transport: undefined, command: "npx", args: ["-y","drawio-mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y drawio-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "miro", label: "Miro Whiteboards", description: "Read/write Miro boards, sticky notes, shapes, frames via OAuth — activate when collaborating on a board.", category: "Whiteboards & Flowcharts", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.miro.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.miro.com/"),
      entry({ name: "lucid", label: "Lucidchart", description: "Flowcharts, diagrams and visual collaboration via OAuth — activate when making or editing diagrams.", category: "Whiteboards & Flowcharts", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.lucid.app)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.lucid.app/mcp"),
    ],
  },

  {
    label: "Web & Scraping",
    entries: [
      entry({ name: "chrome-devtools", label: "Chrome DevTools", description: "Drive Chrome over DevTools protocol: navigate, inspect DOM, execute JS — activate for browser debugging and automation.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","chrome-devtools-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y chrome-devtools-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "browserbase", label: "Browserbase", description: "Cloud browser sessions with live view and screenshots — activate for headed browser tasks in the cloud.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@browserbasehq/mcp-server-browserbase"], envKeys: ["BROWSERBASE_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Browserbase API key", dependency: "npx -y @browserbasehq/mcp-server-browserbase", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "duckduckgo", label: "DuckDuckGo", description: "Fetch search results from DuckDuckGo — activate for quick anonymous web lookups.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@hasdata/duckduckgo-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @hasdata/duckduckgo-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "freshrss", label: "FreshRSS", description: "Read and manage RSS feeds through FreshRSS — activate when a task needs feed items.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@ni-c/freshrss-mcp"], envKeys: ["FRESHRSS_URL","FRESHRSS_API_KEY"], keyGetUrl: undefined, keyGetLabel: "FreshRSS URL + API key", dependency: "npx -y @ni-c/freshrss-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "apify", label: "Apify", description: "3,000+ scraping and automation actors from Apify — activate when scraping websites at scale.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@apify/actors-mcp-server@latest"], envKeys: ["APIFY_TOKEN"], keyGetUrl: "https://console.apify.com/settings/integrations", keyGetLabel: "Get APIFY_TOKEN", dependency: "npx -y @apify/actors-mcp-server@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mcp-server-firecrawl", label: "Firecrawl", description: "Scrape, crawl and search the web for AI agents — activate when extracting site data at scale.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","firecrawl-mcp"], envKeys: ["FIRECRAWL_API_KEY"], keyGetUrl: "https://firecrawl.dev", keyGetLabel: "Get FIRECRAWL_API_KEY", dependency: "npx -y firecrawl-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "tavily-mcp", label: "Tavily Search", description: "Fast AI-native web search, fresh structured results — activate when the task needs current web data.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","tavily-mcp@latest"], envKeys: ["TAVILY_API_KEY"], keyGetUrl: "https://app.tavily.com", keyGetLabel: "Get TAVILY_API_KEY", dependency: "npx -y tavily-mcp@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "brave-search", label: "Brave Search", description: "Privacy-first web search via Brave API — activate when needing fast, clean search results.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-brave-search"], envKeys: ["BRAVE_API_KEY"], keyGetUrl: "https://brave.com/search/api/", keyGetLabel: "Get BRAVE_API_KEY", dependency: "npx -y @modelcontextprotocol/server-brave-search", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "google-search", label: "Google Search", description: "Google Custom Search JSON API results — activate when the task needs Google web results.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","mcp-google-search"], envKeys: ["GOOGLE_API_KEY","GOOGLE_SEARCH_ENGINE_ID"], keyGetUrl: "https://programmablesearchengine.google.com/", keyGetLabel: "Get API key + Engine ID", dependency: "npx -y mcp-google-search", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "google-maps", label: "Google Maps", description: "Places, directions, geocoding, elevation via Google Maps — activate when location/geo data needed.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-google-maps"], envKeys: ["GOOGLE_MAPS_API_KEY"], keyGetUrl: "https://console.cloud.google.com/apis/credentials", keyGetLabel: "Get GOOGLE_MAPS_API_KEY", dependency: "npx -y @modelcontextprotocol/server-google-maps", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "puppeteer", label: "Puppeteer", description: "Headless Chrome — screenshots, scraping, PDF generation — activate for browser automation tasks. Pin PUPPETEER_EXECUTABLE_PATH to a local Chrome to avoid corrupt Puppeteer-cache binaries (macOS errno EBADMACHO).", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-puppeteer"], envKeys: ["PUPPETEER_EXECUTABLE_PATH"], keyGetUrl: undefined, keyGetLabel: "Path to Google Chrome, e.g. /Applications/Google Chrome.app/Contents/MacOS/Google Chrome", dependency: "npx -y @modelcontextprotocol/server-puppeteer (needs PUPPETEER_EXECUTABLE_PATH)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "searxng", label: "SearXNG", description: "Privacy-friendly metasearch across many engines — activate when needing web search results.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","mcp-searxng"], envKeys: ["SEARXNG_URL"], keyGetUrl: undefined, keyGetLabel: "SearXNG instance URL (default public)", dependency: "npx -y mcp-searxng", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mcp-server-fetch", label: "Fetcher (Browser)", description: "Fetch URLs, HTML-to-Markdown, PDF via real browser — activate when reading live web pages.", category: "Web & Scraping", transport: undefined, command: "uvx", args: ["mcp-server-fetch"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "uvx mcp-server-fetch (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mcp-exa", label: "Exa (Search)", description: "Semantic web and code search via live embeddings — activate for research-grade web and code lookup.", category: "Web & Scraping", transport: undefined, command: "npx", args: ["-y","exa-mcp-server"], envKeys: ["EXA_API_KEY"], keyGetUrl: "https://exa.ai", keyGetLabel: "Get EXA_API_KEY", dependency: "npx -y exa-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Code & Git",
    entries: [
      entry({ name: "context7", label: "Context7", description: "Fetch up-to-date docs for any library — activate when coding with unfamiliar dependencies.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","@upstash/context7-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @upstash/context7-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "github-mcp-server", label: "GitHub", description: "Full GitHub API: repos, issues, PRs, code search, actions — activate for GitHub automation.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-github"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"], keyGetUrl: "https://github.com/settings/tokens", keyGetLabel: "Get GITHUB_PERSONAL_ACCESS_TOKEN", dependency: "npx -y @modelcontextprotocol/server-github", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "gitlab-mcp-server", label: "GitLab", description: "GitLab API: projects, merge requests, pipelines, issues — activate for GitLab automation.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","mcp-gitlab"], envKeys: ["GITLAB_TOKEN","GITLAB_URL"], keyGetUrl: "https://gitlab.com/-/profile/personal_access_tokens", keyGetLabel: "Get GITLAB_TOKEN", dependency: "npx -y mcp-gitlab", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "sequential-thinking", label: "Sequential Thinking", description: "Structured multi-step reasoning via connected thoughts — activate for difficult analytical problems.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-sequential-thinking"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @modelcontextprotocol/server-sequential-thinking", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "playwright-mcp", label: "Playwright", description: "Real browser automation — navigation, clicks, screenshots, PDF — activate for UI/end-to-end tasks.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","@playwright/mcp@latest"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @playwright/mcp@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "git-mcp", label: "Git", description: "Commits, branches, diffs, history via Git (keyless) — activate for advanced git operations.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","git-mcp","--repository","/path/to/repo"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y git-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "filesystem-mcp", label: "Filesystem", description: "Read/write files, list directories, search/edit text (keyless) — activate when direct filesystem calls needed.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-filesystem","/tmp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @modelcontextprotocol/server-filesystem", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "typescript-sdk", label: "TypeScript SDK", description: "Execute TypeScript safely in a V8 isolate (keyless) — activate for sandboxed TS scripting.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","typescript-sdk"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y typescript-sdk", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "everything", label: "Everything (Sample)", description: "Hosts every tool/resource type for testing (keyless) — activate only to verify MCP plumbing.", category: "Code & Git", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-everything"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @modelcontextprotocol/server-everything", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mcp-server-sqlite", label: "SQLite (read/write)", description: "Query and create SQLite databases via SQL — activate when working with local SQLite files.", category: "Code & Git", transport: undefined, command: "uvx", args: ["mcp-server-sqlite","--db-path","~/.smokemonkey/app.db"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "uvx mcp-server-sqlite (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Databases & Storage",
    entries: [
      entry({ name: "postgres-mcp-server", label: "PostgreSQL", description: "Inspect and query Postgres, run read/write SQL — activate when working with PostgreSQL databases.", category: "Databases & Storage", transport: undefined, command: "npx", args: ["-y","postgres-mcp-server"], envKeys: ["DB_HOST","DB_PORT","DB_USER","DB_PASSWORD","DB_NAME","DB_SSL"], keyGetUrl: undefined, keyGetLabel: "PostgreSQL connection details", dependency: "npx -y postgres-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "redis-mcp-server", label: "Redis", description: "Read/write Redis keys, hashes, sorted sets — activate when caching or queue data needs poking.", category: "Databases & Storage", transport: undefined, command: "npx", args: ["-y","redis-mcp","--redis-host","localhost","--redis-port","6379"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y redis-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mysql-mcp-server", label: "MySQL", description: "Run SQL, inspect/update MySQL/MariaDB schemas — activate when working with MySQL databases.", category: "Databases & Storage", transport: undefined, command: "npx", args: ["-y","mysql-mcp-server"], envKeys: ["DB_HOST","DB_PORT","DB_USER","DB_PASSWORD","DB_NAME"], keyGetUrl: undefined, keyGetLabel: "MySQL connection details", dependency: "npx -y mysql-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "clickhouse", label: "ClickHouse", description: "Run SQL over ClickHouse tables, views and materialized views — activate when querying ClickHouse OLAP data.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["mcp-clickhouse"], envKeys: ["CLICKHOUSE_HOST","CLICKHOUSE_PORT","CLICKHOUSE_USER","CLICKHOUSE_PASSWORD","CLICKHOUSE_DB"], keyGetUrl: undefined, keyGetLabel: "ClickHouse host/user/password", dependency: "uvx mcp-clickhouse (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mongodb-atlas", label: "MongoDB Atlas", description: "Admin MongoDB: CRUD documents, aggregation pipelines, indexes — activate for MongoDB data tasks.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["mongo-mcp"], envKeys: ["MONGODB_URI"], keyGetUrl: undefined, keyGetLabel: "MongoDB connection string (cloud.mongodb.com)", dependency: "uvx mongo-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "dynamodb", label: "Amazon DynamoDB", description: "Query, scan and write DynamoDB items and tables — activate when working with DynamoDB data.", category: "Databases & Storage", transport: undefined, command: "npx", args: ["-y","aws-dynamodb-mcp-server"], envKeys: ["AWS_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"], keyGetUrl: undefined, keyGetLabel: "AWS credentials (or ~/.aws/config)", dependency: "npx -y aws-dynamodb-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "neo4j", label: "Neo4j Cypher", description: "Run Cypher queries, CRUD nodes and relationships, inspect schema — activate when working with a Neo4j graph.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["mcp-neo4j-cypher"], envKeys: ["NEO4J_URI","NEO4J_USERNAME","NEO4J_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "Neo4j URI + credentials", dependency: "uvx mcp-neo4j-cypher (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "elasticsearch", label: "Elasticsearch", description: "Search indices, documents and mappings in Elasticsearch — activate when querying ES data.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["elasticsearch-mcp-server"], envKeys: ["ELASTICSEARCH_URL","ELASTICSEARCH_API_KEY"], keyGetUrl: undefined, keyGetLabel: "ES URL + API key", dependency: "uvx elasticsearch-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mssql", label: "Microsoft SQL Server", description: "Query MS SQL Server tables and run administrative SQL — activate for MSSQL data work.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["mcp-server-mssql"], envKeys: ["DB_HOST","DB_PORT","DB_USER","DB_PASSWORD","DB_NAME"], keyGetUrl: undefined, keyGetLabel: "MSSQL connection details", dependency: "uvx mcp-server-mssql (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "snowflake", label: "Snowflake", description: "Run SQL and warehouse queries against Snowflake — activate when analyzing data in Snowflake.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["mcp-snowflake-server-nsp"], envKeys: ["SNOWFLAKE_ACCOUNT","SNOWFLAKE_USER","SNOWFLAKE_PASSWORD","SNOWFLAKE_DB"], keyGetUrl: undefined, keyGetLabel: "Snowflake account + credentials", dependency: "uvx mcp-snowflake-server-nsp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "kafka", label: "Apache Kafka", description: "Inspect topics, consume/produce messages, monitor consumer offsets — activate when working with Kafka.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["kafka-dataops-mcp"], envKeys: ["KAFKA_BOOTSTRAP_SERVERS","KAFKA_SASL_USERNAME","KAFKA_SASL_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "Kafka bootstrap servers + SASL creds", dependency: "uvx kafka-dataops-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "couchbase", label: "Couchbase", description: "Query Couchbase buckets with N1QL and manage documents — activate for Couchbase data access.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["couchbase-mcp-server"], envKeys: ["COUCHBASE_CONNECTION_STRING","COUCHBASE_USERNAME","COUCHBASE_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "Couchbase connection string", dependency: "uvx couchbase-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "spark-sql", label: "Apache Spark SQL", description: "Run SQL and DataFrame queries against Apache Spark — activate for big-data analytics.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["spark-sql-mcp-server"], envKeys: ["SPARK_HOST","SPARK_PORT"], keyGetUrl: undefined, keyGetLabel: "Spark host/port", dependency: "uvx spark-sql-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "fivetran", label: "Fivetran", description: "Manage connectors, destinations and syncs — activate for data pipeline orchestration.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["fivetran-mcp"], envKeys: ["FIVETRAN_API_KEY","FIVETRAN_ACCOUNT_ID"], keyGetUrl: undefined, keyGetLabel: "Fivetran API key + account", dependency: "uvx fivetran-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "queue-aiops", label: "RabbitMQ", description: "Inspect queues, messages and exchanges in RabbitMQ — activate for message-broker operations.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["queue-aiops"], envKeys: ["RABBITMQ_HOST","RABBITMQ_USER","RABBITMQ_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "RabbitMQ host + credentials", dependency: "uvx queue-aiops (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "kusto", label: "Azure Data Explorer", description: "Run KQL queries against Azure Data Explorer — activate for Azure Kusto analytics.", category: "Databases & Storage", transport: undefined, command: "uvx", args: ["kusto-mcp"], envKeys: ["KUSTO_CLUSTER","KUSTO_DATABASE","KUSTO_TENANT_ID","KUSTO_CLIENT_ID"], keyGetUrl: undefined, keyGetLabel: "Kusto cluster + app creds", dependency: "uvx kusto-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mongodb-mcp-server", label: "MongoDB", description: "Explore and query MongoDB collections — activate when working with MongoDB data.", category: "Databases & Storage", transport: undefined, command: "npx", args: ["-y","mongodb-mcp-server"], envKeys: ["MONGODB_URI"], keyGetUrl: undefined, keyGetLabel: "MongoDB connection string (MongoDB Atlas: cloud.mongodb.com)", dependency: "npx -y mongodb-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "sqlite", label: "SQLite (core)", description: "Read/write SQLite with SQL over MCP — activate when querying local SQLite databases.", category: "Databases & Storage", transport: undefined, command: "npx", args: ["-y","sqlite-mcp-server","--db-path","~/.smokemonkey/app.db"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y sqlite-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Observability & Dev Tools",
    entries: [
      entry({ name: "postman", label: "Postman", description: "Run Postman collections, inspect requests and responses — activate when executing API test suites.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","@postman/postman-mcp-server"], envKeys: ["POSTMAN_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Postman API key", dependency: "npx -y @postman/postman-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "posthog", label: "PostHog", description: "Query PostHog events, insights, dashboards and feature flags — activate for product analytics.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","posthog-mcp-server"], envKeys: ["POSTHOG_API_KEY","POSTHOG_PROJECT_ID"], keyGetUrl: undefined, keyGetLabel: "PostHog API key + project id", dependency: "npx -y posthog-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "azure-devops", label: "Azure DevOps", description: "Manage Azure DevOps boards, repos, pipelines and projects — activate for Azure DevOps work.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","@dockndevai/mcp-azure-devops"], envKeys: ["AZURE_DEVOPS_PAT","AZURE_DEVOPS_ORG"], keyGetUrl: undefined, keyGetLabel: "Azure DevOps PAT + org", dependency: "npx -y @dockndevai/mcp-azure-devops", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mixpanel", label: "Mixpanel", description: "Query Mixpanel events, cohorts and insights — activate when analyzing product behavior.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","mixpanel-mcp"], envKeys: ["MIXPANEL_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Mixpanel API key", dependency: "npx -y mixpanel-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "sentry-mcp-server", label: "Sentry", description: "Create/manage Sentry issues, events, releases — activate when debugging or triaging production errors.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","@sentry/mcp-server"], envKeys: ["SENTRY_ACCESS_TOKEN"], keyGetUrl: "https://sentry.io/settings/account/api/auth-tokens/", keyGetLabel: "Get SENTRY_ACCESS_TOKEN", dependency: "npx -y @sentry/mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "newrelic-mcp-server", label: "New Relic", description: "Run NRQL queries, dashboards and alerts — activate when analyzing New Relic telemetry.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","newrelic-mcp"], envKeys: ["NEW_RELIC_API_KEY","NEW_RELIC_ACCOUNT_ID"], keyGetUrl: "https://one.newrelic.com/admin-portal/api-keys/home", keyGetLabel: "Get NEW_RELIC_API_KEY", dependency: "npx -y newrelic-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "grafana", label: "Grafana", description: "Query Grafana dashboards, datasources, alerts — activate when inspecting dashboards or metrics.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","mcp-grafana-npx"], envKeys: ["GRAFANA_URL","GRAFANA_API_KEY"], keyGetUrl: "https://grafana.com/", keyGetLabel: "Get GRAFANA_URL + API key", dependency: "npx -y mcp-grafana-npx", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "datadog", label: "Datadog", description: "Query Datadog metrics, logs, incidents — activate when investigating monitored apps or infra.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","datadog-mcp-server"], envKeys: ["DATADOG_API_KEY","DATADOG_APP_KEY"], keyGetUrl: "https://app.datadoghq.com/organization-settings/api-keys", keyGetLabel: "Get DATADOG_API_KEY", dependency: "npx -y datadog-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "sonarqube", label: "SonarQube", description: "Review code quality, issues, metrics and quality gates — activate when checking code maintainability.", category: "Observability & Dev Tools", transport: undefined, command: "uvx", args: ["sonarqube-mcp"], envKeys: ["SONAR_HOST_URL","SONAR_TOKEN"], keyGetUrl: undefined, keyGetLabel: "SonarQube URL + token", dependency: "uvx sonarqube-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "argocd", label: "Argo CD", description: "Inspect and sync Argo CD applications and rollouts — activate when managing GitOps deployments.", category: "Observability & Dev Tools", transport: undefined, command: "uvx", args: ["argocd-mcp-server"], envKeys: ["ARGOCD_URL","ARGOCD_TOKEN"], keyGetUrl: undefined, keyGetLabel: "ArgoCD URL + token", dependency: "uvx argocd-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mlflow", label: "MLflow", description: "Track experiment runs, models and artifacts — activate for ML experiment tracking.", category: "Observability & Dev Tools", transport: undefined, command: "uvx", args: ["mlflow-mcp"], envKeys: ["MLFLOW_TRACKING_URI","MLFLOW_TRACKING_TOKEN"], keyGetUrl: undefined, keyGetLabel: "MLflow tracking URI", dependency: "uvx mlflow-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "graphql", label: "GraphQL (Schema-driven)", description: "Query any GraphQL endpoint through auto-generated tools — activate when an API uses GraphQL.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","graphql-to-mcp"], envKeys: ["GRAPHQL_ENDPOINT"], keyGetUrl: undefined, keyGetLabel: "GraphQL endpoint URL", dependency: "npx -y graphql-to-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "awx", label: "AWX / Ansible Tower", description: "Run Ansible jobs and manage inventories through AWX — activate for automation workflows.", category: "Observability & Dev Tools", transport: undefined, command: "uvx", args: ["awx-mcp-server"], envKeys: ["AWX_HOST","AWX_TOKEN"], keyGetUrl: undefined, keyGetLabel: "AWX URL + token", dependency: "uvx awx-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "circleci", label: "CircleCI", description: "Inspect pipelines, workflows and jobs — activate for CircleCI builds.", category: "Observability & Dev Tools", transport: undefined, command: "uvx", args: ["mcparmory-circleci"], envKeys: ["CIRCLECI_TOKEN","CIRCLECI_SLUG"], keyGetUrl: undefined, keyGetLabel: "CircleCI personal token + slug", dependency: "uvx mcparmory-circleci (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "prometheus", label: "Prometheus", description: "Query Prometheus metrics via PromQL — activate when checking monitoring or alerting data.", category: "Observability & Dev Tools", transport: undefined, command: "npx", args: ["-y","prometheus-mcp"], envKeys: ["PROMETHEUS_URL"], keyGetUrl: undefined, keyGetLabel: "PROMETHEUS_URL (e.g. http://localhost:9090)", dependency: "npx -y prometheus-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "agent-skills-qa", label: "Agent Skills — QA", description: "Quality/testing skills (test-driven-development, browser-testing-with-devtools, debugging-and-error-recovery, constraint-driven-development, code-review-and-quality, doubt-driven-development) — activate when writing tests, reviewing code quality, or driving TDD/QA workflows.", category: "Observability & Dev Tools", transport: undefined, command: "node", args: ["{SM_REPO_ROOT}/server/agent-skills/mcp/server.mjs","--domain=qa"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Bundled · node server/agent-skills/mcp/server.mjs --domain=qa", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Communication & Productivity",
    entries: [
      entry({ name: "teams", label: "Microsoft Teams", description: "Read and send Teams chat and channel messages — activate when working in Microsoft Teams.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-microsoft-teams"], envKeys: ["MS_CLIENT_ID","MS_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "Azure app credentials", dependency: "npx -y @mindstone/mcp-server-microsoft-teams", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "discord", label: "Discord", description: "Send and read Discord messages, channels and guilds — activate for Discord automation.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@pasympa/discord-mcp"], envKeys: ["DISCORD_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Discord bot token", dependency: "npx -y @pasympa/discord-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "whatsapp", label: "WhatsApp Cloud", description: "Send and receive WhatsApp messages via Cloud API — activate for WhatsApp messaging.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@codespar/mcp-whatsapp-cloud"], envKeys: ["WHATSAPP_ACCESS_TOKEN","WHATSAPP_PHONE_NUMBER_ID"], keyGetUrl: undefined, keyGetLabel: "WhatsApp access token + phone", dependency: "npx -y @codespar/mcp-whatsapp-cloud", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "hubspot", label: "HubSpot", description: "Manage contacts, deals, tickets and marketing — activate for HubSpot CRM.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-hubspot"], envKeys: ["HUBSPOT_API_KEY"], keyGetUrl: undefined, keyGetLabel: "HubSpot API key", dependency: "npx -y @mindstone/mcp-server-hubspot", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "salesforce", label: "Salesforce", description: "Query accounts, opportunities and leads with SOQL — activate for Salesforce CRM.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-salesforce"], envKeys: ["SF_CLIENT_ID","SF_CLIENT_SECRET","SF_USERNAME"], keyGetUrl: undefined, keyGetLabel: "Salesforce connected app creds", dependency: "npx -y @mindstone/mcp-server-salesforce", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "zendesk", label: "Zendesk", description: "Manage Zendesk tickets, users and organizations — activate for Zendesk support.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-zendesk"], envKeys: ["ZENDESK_SUBDOMAIN","ZENDESK_API_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Zendesk subdomain + token", dependency: "npx -y @mindstone/mcp-server-zendesk", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "confluence", label: "Confluence Cloud", description: "Search, read and create Confluence pages — activate for Confluence documentation.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@aaronsb/confluence-cloud-mcp"], envKeys: ["CONFLUENCE_URL","CONFLUENCE_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Confluence URL + token", dependency: "npx -y @aaronsb/confluence-cloud-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "pipedrive", label: "Pipedrive", description: "Manage deals, contacts and pipelines in Pipedrive — activate for Pipedrive CRM.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@ckalima/pipedrive-mcp-server"], envKeys: ["PIPEDRIVE_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Pipedrive API token", dependency: "npx -y @ckalima/pipedrive-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "google-chat", label: "Google Chat", description: "Send and read Google Chat messages — activate when collaborating in Google Chat.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","mcp-google-chat"], envKeys: ["GOOGLE_CREDENTIALS"], keyGetUrl: undefined, keyGetLabel: "Google service account creds", dependency: "npx -y mcp-google-chat", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "intercom", label: "Intercom", description: "Manage conversations, contacts and companies — activate for Intercom customer messaging.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","claude-intercom"], envKeys: ["INTERCOM_ACCESS_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Intercom access token", dependency: "npx -y claude-intercom", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "freshdesk", label: "Freshdesk", description: "Manage Freshdesk tickets and contacts — activate for Freshdesk support.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-freshdesk"], envKeys: ["FRESHDESK_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Freshdesk API key", dependency: "npx -y @mindstone/mcp-server-freshdesk", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "linear-mcp-server", label: "Linear", description: "Create/manage Linear issues, cycles, roadmaps — activate when tracking work in Linear.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","linear-mcp-server"], envKeys: ["LINEAR_API_KEY"], keyGetUrl: "https://linear.app/settings/api", keyGetLabel: "Get LINEAR_API_KEY", dependency: "npx -y linear-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "notion-mcp-server", label: "Notion", description: "Search/read/write Notion pages, databases, comments — activate when working with Notion content.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@notionhq/notion-mcp-server"], envKeys: ["NOTION_TOKEN"], keyGetUrl: "https://www.notion.so/my-integrations", keyGetLabel: "Get NOTION_TOKEN", dependency: "npx -y @notionhq/notion-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "jira-mcp-server", label: "Jira", description: "JQL search and issue retrieval from Jira Cloud — activate when fixing or referencing Jira tickets.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","jira-mcp"], envKeys: ["JIRA_INSTANCE_URL","JIRA_USER_EMAIL","JIRA_API_KEY"], keyGetUrl: "https://id.atlassian.com/manage-profile/security/api-tokens", keyGetLabel: "Get JIRA_API_KEY", dependency: "npx -y jira-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mattermost", label: "Mattermost", description: "Read channels, post messages, search threads — activate when the task involves Mattermost.", category: "Communication & Productivity", transport: undefined, command: "npx", args: ["-y","@conarti/mattermost-mcp"], envKeys: ["MATTERMOST_BASE_URL","MATTERMOST_ACCESS_TOKEN"], keyGetUrl: undefined, keyGetLabel: "MATTERMOST_BASE_URL + personal access token", dependency: "npx -y @conarti/mattermost-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "telegram", label: "Telegram", description: "Send and read Telegram messages, chats and media — activate for Telegram interactions.", category: "Communication & Productivity", transport: undefined, command: "uvx", args: ["better-telegram-mcp"], envKeys: ["TELEGRAM_API_ID","TELEGRAM_API_HASH","TELEGRAM_SESSION"], keyGetUrl: undefined, keyGetLabel: "Telegram API id/hash + session", dependency: "uvx better-telegram-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "servicenow", label: "ServiceNow", description: "Read and write ServiceNow tables, CMDB and incidents — activate for ServiceNow ITSM.", category: "Communication & Productivity", transport: undefined, command: "uvx", args: ["mcp-server-servicenow"], envKeys: ["SERVICENOW_URL","SERVICENOW_USER","SERVICENOW_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "ServiceNow URL + login", dependency: "uvx mcp-server-servicenow (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "servicenow-cmdb", label: "ServiceNow CMDB", description: "Query ServiceNow CMDB, incidents and tables — activate for ServiceNow ITSM.", category: "Communication & Productivity", transport: undefined, command: "uvx", args: ["mcp-server-servicenow"], envKeys: ["SERVICENOW_URL","SERVICENOW_USER","SERVICENOW_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "ServiceNow URL + login", dependency: "uvx mcp-server-servicenow (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "slack-mcp-server", label: "Slack", description: "Post messages, list channels, read threads — activate when the task involves Slack communication.", category: "Communication & Productivity", transport: undefined, command: "docker", args: ["run","--rm","-i","-e","SLACK_BOT_TOKEN","-e","SLACK_TEAM_ID","mcp/slack"], envKeys: ["SLACK_BOT_TOKEN","SLACK_TEAM_ID"], keyGetUrl: "https://api.slack.com/apps", keyGetLabel: "Get SLACK_BOT_TOKEN (needs Docker)", dependency: "docker run --rm -i mcp/slack (needs Docker)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "AI & Vector Search",
    entries: [
      entry({ name: "ollama", label: "Ollama", description: "Run local LLMs through an Ollama server — activate for offline or local model inference.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","ollama-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y ollama-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "elevenlabs", label: "ElevenLabs", description: "Text-to-speech, voice cloning and audio generation — activate when producing speech or audio.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-elevenlabs"], envKeys: ["ELEVENLABS_API_KEY"], keyGetUrl: undefined, keyGetLabel: "ElevenLabs API key", dependency: "npx -y @mindstone/mcp-server-elevenlabs", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "replicate", label: "Replicate", description: "Run thousands of AI models for image, video and audio — activate when generating media via model APIs.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","replicate-mcp-server"], envKeys: ["REPLICATE_API_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Replicate API token", dependency: "npx -y replicate-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mem0", label: "Mem0", description: "Persistent memory store: add, search and delete long-term memories — activate to remember context across sessions.", category: "AI & Vector Search", transport: "http", command: "", args: [], envKeys: ["MEM0_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Mem0 API key", dependency: "Remote · mcp.mem0.ai/mcp", remote: true, manualOAuth: undefined, oauthScopes: undefined }, "https://mcp.mem0.ai/mcp"),
      entry({ name: "pinecone-mcp", label: "Pinecone", description: "Create/query Pinecone vector indexes, upsert vectors — activate for RAG or similarity search.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","@pinecone-database/mcp"], envKeys: ["PINECONE_API_KEY"], keyGetUrl: "https://app.pinecone.io", keyGetLabel: "Get PINECONE_API_KEY", dependency: "npx -y @pinecone-database/mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "hf-inference", label: "Hugging Face", description: "Run HF inference — text, embeddings, vision, audio models — activate when calling Hugging Face models.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","huggingface-mcp-server"], envKeys: ["HF_TOKEN"], keyGetUrl: "https://huggingface.co/settings/tokens", keyGetLabel: "Get HF_TOKEN", dependency: "npx -y huggingface-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "openai", label: "OpenAI SDK", description: "OpenAI-compatible chat, embeddings, images via API key — activate when calling OpenAI models.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","openai-mcp-server"], envKeys: ["OPENAI_API_KEY"], keyGetUrl: "https://platform.openai.com/api-keys", keyGetLabel: "Get OPENAI_API_KEY", dependency: "npx -y openai-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "openrouter", label: "OpenRouter", description: "Access 200+ LLMs through one API — activate when a task needs an extra model or fallback.", category: "AI & Vector Search", transport: undefined, command: "uvx", args: ["mcp-openrouter"], envKeys: ["OPENROUTER_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Get OPENROUTER_API_KEY", dependency: "uvx mcp-openrouter (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "qdrant-mcp", label: "Qdrant", description: "Vector search with filtering — activate for RAG or semantic similarity across embeddings.", category: "AI & Vector Search", transport: undefined, command: "uvx", args: ["mcp-server-qdrant"], envKeys: ["QDRANT_URL","QDRANT_API_KEY","COLLECTION_NAME"], keyGetUrl: "https://cloud.qdrant.io", keyGetLabel: "Get QDRANT_API_KEY", dependency: "uvx mcp-server-qdrant (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "memory-mcp", label: "Memory (Knowledge Graph)", description: "Persistent knowledge-graph memory, entities/relations (keyless) — activate to remember across runs.", category: "AI & Vector Search", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-memory"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @modelcontextprotocol/server-memory", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Cloudflare",
    entries: [
      entry({ name: "cloudflare-api", label: "Cloudflare API", description: "Manage Cloudflare DNS, Workers, R2, Zero Trust — activate when working with Cloudflare services.", category: "Cloudflare", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.cloudflare.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.cloudflare.com/mcp"),
    ],
  },

  {
    label: "Hosting & Backend",
    entries: [
      entry({ name: "firebase", label: "Firebase", description: "Manage Firebase projects, Firestore, Auth, Storage, functions and more via the official Firebase CLI — uses your local Firebase login (firebase login / ADC), no API key needed. First run the firebase_login tool to sign in.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","firebase-tools@latest","mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y firebase-tools@latest mcp (needs local firebase login / ADC)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "convex", label: "Convex", description: "Manage Convex functions, tables and deployments — activate for Convex app backends.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","convexity-mcp"], envKeys: ["CONVEX_URL","CONVEX_DEPLOY_KEY"], keyGetUrl: undefined, keyGetLabel: "Convex URL + deploy key", dependency: "npx -y convexity-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "neon", label: "Neon", description: "Manage Neon Postgres branches, roles and databases — activate for Neon Postgres operations.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","neon-mcp-server"], envKeys: ["NEON_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Neon API key", dependency: "npx -y neon-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "sharepoint", label: "Microsoft SharePoint", description: "Search and manage SharePoint sites, lists and documents — activate for SharePoint file work.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-microsoft-sharepoint"], envKeys: ["MS_CLIENT_ID","MS_CLIENT_SECRET","SHAREPOINT_SITE"], keyGetUrl: undefined, keyGetLabel: "Azure app + site URL", dependency: "npx -y @mindstone/mcp-server-microsoft-sharepoint", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "onedrive", label: "Microsoft OneDrive", description: "List, read and upload files in Microsoft OneDrive — activate for OneDrive file storage.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-microsoft-files"], envKeys: ["MS_CLIENT_ID","MS_CLIENT_SECRET","USER_TIMEZONE"], keyGetUrl: undefined, keyGetLabel: "Azure app + tenant", dependency: "npx -y @mindstone/mcp-server-microsoft-files", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "backblaze", label: "Backblaze B2", description: "Store, list and download objects in Backblaze B2 — activate for B2 object storage.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@backblaze-labs/b2-mcp"], envKeys: ["BO_B2_APPLICATION_KEY","BUCKET_ID"], keyGetUrl: undefined, keyGetLabel: "B2 app key + bucket id", dependency: "npx -y @backblaze-labs/b2-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "wordpress", label: "WordPress", description: "Create and manage WordPress posts and content — activate for WordPress CMS tasks.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@respira/wordpress-mcp-server"], envKeys: ["WP_BASE_URL","WP_APP_USERNAME","WP_APP_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "WP URL + app credentials", dependency: "npx -y @respira/wordpress-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "sharepoint-lists", label: "SharePoint Lists", description: "Manage SharePoint lists, items and columns — activate for SharePoint list work.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-microsoft-sharepoint"], envKeys: ["MS_CLIENT_ID","MS_CLIENT_SECRET","SHAREPOINT_SITE"], keyGetUrl: undefined, keyGetLabel: "Azure app + SharePoint site", dependency: "npx -y @mindstone/mcp-server-microsoft-sharepoint", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "netlify", label: "Netlify", description: "Deploy static sites/functions, manage builds and env vars — activate when deploying to Netlify.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@netlify/mcp"], envKeys: ["NETLIFY_AUTH_TOKEN"], keyGetUrl: "https://app.netlify.com/user/applications#personal-access-tokens", keyGetLabel: "Personal access token", dependency: "npx -y @netlify/mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "aws-nx", label: "AWS", description: "Scaffold full-stack apps with Lambda/API Gateway/CDK/S3 — activate when deploying AWS backends.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@aws/nx-plugin-mcp"], envKeys: ["AWS_PROFILE","AWS_REGION"], keyGetUrl: undefined, keyGetLabel: "Uses ~/.aws credentials", dependency: "npx -y @aws/nx-plugin-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "azure", label: "Azure", description: "Manage Azure App Service, compute, databases — activate when deploying backends to Azure.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","@azure/mcp@latest","server","start"], envKeys: ["AZURE_TENANT_ID","AZURE_CLIENT_ID","AZURE_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "Uses az login or service principal env vars", dependency: "npx -y @azure/mcp server start", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "docker", label: "Docker", description: "Manage containers, images and compose stacks — activate for container operations and debugging.", category: "Hosting & Backend", transport: undefined, command: "docker", args: ["run","--rm","-i","mcp/docker"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "docker run --rm -i mcp/docker (needs Docker)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "digitalocean", label: "DigitalOcean", description: "Manage droplets, Kubernetes, Spaces and DNS — activate for DigitalOcean infrastructure.", category: "Hosting & Backend", transport: undefined, command: "uvx", args: ["mcp-server-digitalocean"], envKeys: ["DIGITALOCEAN_API_TOKEN"], keyGetUrl: undefined, keyGetLabel: "DigitalOcean API token", dependency: "uvx mcp-server-digitalocean (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "databricks", label: "Databricks", description: "Run SQL, jobs and ML workloads on Databricks — activate for Databricks analytics.", category: "Hosting & Backend", transport: undefined, command: "uvx", args: ["databricks-sdk-mcp"], envKeys: ["DATABRICKS_HOST","DATABRICKS_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Databricks host + token", dependency: "uvx databricks-sdk-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      
      entry({ name: "render", label: "Render", description: "Deploy/manage Render services, sites, Postgres/Redis — activate when deploying or scaling on Render.", category: "Hosting & Backend", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.render.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.render.com/mcp"),
      entry({ name: "supabase", label: "Supabase", description: "Query Supabase Postgres, run SQL, manage auth/storage/migrations — activate for Supabase projects.", category: "Hosting & Backend", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.supabase.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.supabase.com/mcp"),
      entry({ name: "vercel", label: "Vercel", description: "Deploy/manage Vercel projects, deployments, env vars, logs — activate when deploying to Vercel.", category: "Hosting & Backend", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.vercel.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.vercel.com"),
      entry({ name: "railway", label: "Railway", description: "Deploy Railway apps, services, databases, manage variables — activate when hosting on Railway.", category: "Hosting & Backend", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.railway.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.railway.com"),
      entry({ name: "fly", label: "Fly.io", description: "Provision Fly apps, machines, volumes, secrets — activate when deploying apps to Fly.io.", category: "Hosting & Backend", transport: undefined, command: "fly", args: ["mcp","server"], envKeys: ["FLY_ACCESS_TOKEN"], keyGetUrl: "https://fly.io/docs/security/tokens/", keyGetLabel: "Personal access token (optional)", dependency: "fly mcp server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "bigquery", label: "Google BigQuery", description: "Query BigQuery datasets, run SQL/ML analytics — activate when analyzing large data in BigQuery.", category: "Hosting & Backend", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · Manual OAuth (bigquery.googleapis.com)", remote: true, manualOAuth: true, oauthScopes: undefined}, "https://bigquery.googleapis.com/mcp"),
      entry({ name: "cloudsql", label: "Google Cloud SQL", description: "Create/manage/query Cloud SQL instances (Postgres/MySQL) — activate when working with Google Cloud databases.", category: "Hosting & Backend", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · Manual OAuth (sqladmin.googleapis.com)", remote: true, manualOAuth: true, oauthScopes: undefined}, "https://sqladmin.googleapis.com/mcp"),
      entry({ name: "terraform", label: "Terraform", description: "Inspect Terraform state, plan and apply IaC — activate when managing infrastructure as code.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","terraform-mcp-server"], envKeys: ["TFC_TOKEN","TERRAFORM_REGISTRY_URL"], keyGetUrl: "https://app.terraform.io/app/settings/tokens", keyGetLabel: "Terraform Cloud token (optional)", dependency: "npx -y terraform-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "kubernetes", label: "Kubernetes", description: "List pods/deployments, inspect clusters, apply manifests — activate when working with Kubernetes.", category: "Hosting & Backend", transport: undefined, command: "npx", args: ["-y","mcp-server-kubernetes"], envKeys: ["KUBECONFIG"], keyGetUrl: undefined, keyGetLabel: "KUBECONFIG path (default ~/.kube/config)", dependency: "npx -y mcp-server-kubernetes", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "agent-skills-backend", label: "Agent Skills — Backend", description: "Backend/API engineering skills (api-and-interface-design, security-and-hardening, spec-driven-development, test-driven-development, debugging-and-error-recovery) — activate when designing APIs, backend data models, or hardening server code.", category: "Hosting & Backend", transport: undefined, command: "node", args: ["{SM_REPO_ROOT}/server/agent-skills/mcp/server.mjs","--domain=backend"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Bundled · node server/agent-skills/mcp/server.mjs --domain=backend", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "agent-skills-devops", label: "Agent Skills — DevOps", description: "DevOps/deployment skills (ci-cd-and-automation, shipping-and-launch, deprecation-and-migration, observability-and-instrumentation, security-and-hardening, performance-optimization, git-workflow-and-versioning) — activate when deploying, shipping, migrating or hardening infrastructure/CI.", category: "Hosting & Backend", transport: undefined, command: "node", args: ["{SM_REPO_ROOT}/server/agent-skills/mcp/server.mjs","--domain=devops"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Bundled · node server/agent-skills/mcp/server.mjs --domain=devops", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "File System & Storage",
    entries: [
      entry({ name: "dropbox", label: "Dropbox", description: "List, search, download, upload Dropbox files — activate when accessing Dropbox storage.", category: "File System & Storage", transport: undefined, command: "npx", args: ["-y","@pipeworx/mcp-dropbox"], envKeys: ["DROPBOX_ACCESS_TOKEN"], keyGetUrl: "https://www.dropbox.com/developers/apps", keyGetLabel: "Create app → get access token", dependency: "npx -y @pipeworx/mcp-dropbox", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "gdrive", label: "Google Drive", description: "Read, search and manage Google Drive files — activate when fetching or organizing Drive content.", category: "File System & Storage", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · Manual OAuth (drive.googleapis.com)", remote: true, manualOAuth: true, oauthScopes: undefined}, "https://drive.googleapis.com/mcp"),
      entry({ name: "filesystem-local", label: "Filesystem (local)", description: "Safe local file access, read/write text, list, search — activate when managing files on disk.", category: "File System & Storage", transport: undefined, command: "npx", args: ["-y","@modelcontextprotocol/server-filesystem","~"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @modelcontextprotocol/server-filesystem", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "s3-storage", label: "S3 Storage (AWS)", description: "List S3 buckets, browse/upload/download objects, presigned URLs — activate for S3 storage work.", category: "File System & Storage", transport: undefined, command: "npx", args: ["-y","mcp-server-s3"], envKeys: ["AWS_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"], keyGetUrl: undefined, keyGetLabel: "AWS credentials (or ~/.aws/config)", dependency: "npx -y mcp-server-s3", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Email & Calendar",
    entries: [
      entry({ name: "google-workspace", label: "Google Workspace", description: "Drive, Docs, Sheets, Gmail and Calendar tools — activate for Google Workspace files and mail.", category: "Email & Calendar", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-google-workspace"], envKeys: ["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "Google OAuth client creds", dependency: "npx -y @mindstone/mcp-server-google-workspace", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "outlook", label: "Microsoft Outlook", description: "Search, read and send Outlook mail and calendar — activate for Outlook email tasks.", category: "Email & Calendar", transport: undefined, command: "npx", args: ["-y","@mcp-z/mcp-outlook"], envKeys: ["MS_CLIENT_ID","MS_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "Azure app credentials", dependency: "npx -y @mcp-z/mcp-outlook", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "resend", label: "Resend", description: "Send transactional email through the Resend API — activate when dispatching email.", category: "Email & Calendar", transport: undefined, command: "npx", args: ["-y","resend-email-mcp"], envKeys: ["RESEND_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Reset at resend.com/keys", dependency: "npx -y resend-email-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "sendgrid", label: "SendGrid", description: "Send email and manage templates via SendGrid — activate when sending transactional mail at scale.", category: "Email & Calendar", transport: undefined, command: "npx", args: ["-y","@codespar/mcp-sendgrid"], envKeys: ["SENDGRID_API_KEY"], keyGetUrl: undefined, keyGetLabel: "SendGrid API key", dependency: "npx -y @codespar/mcp-sendgrid", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mailchimp", label: "Mailchimp", description: "Manage mailchimp audiences, campaigns and reports — activate for Mailchimp marketing email.", category: "Email & Calendar", transport: undefined, command: "uvx", args: ["mailchimp-mcp-server"], envKeys: ["MAILCHIMP_API_KEY","MAILCHIMP_DC"], keyGetUrl: undefined, keyGetLabel: "Mailchimp API key + datacenter", dependency: "uvx mailchimp-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "google-workspace-suite", label: "Google Workspace (Full)", description: "Drive, Docs, Sheets, Gmail, Calendar tools — activate for Google Workspace.", category: "Email & Calendar", transport: undefined, command: "npx", args: ["-y","@mindstone/mcp-server-google-workspace"], envKeys: ["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "Google OAuth app creds", dependency: "npx -y @mindstone/mcp-server-google-workspace", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "gmail", label: "Gmail", description: "Read, search, send Gmail threads — activate when the task involves Gmail email access.", category: "Email & Calendar", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · Manual OAuth (gmail.googleapis.com)", remote: true, manualOAuth: true, oauthScopes: undefined}, "https://gmail.googleapis.com/mcp"),
      entry({ name: "gcal", label: "Google Calendar", description: "View, create, manage Google Calendar events — activate when scheduling or checking calendars.", category: "Email & Calendar", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · Manual OAuth (calendar)", remote: true, manualOAuth: true, oauthScopes: undefined}, "https://www.googleapis.com/calendar/v3/mcp"),
    ],
  },

  {
    label: "Search & Research",
    entries: [
      entry({ name: "wayback", label: "Wayback Machine", description: "Fetch archived snapshots of any URL — activate when checking historical page versions.", category: "Search & Research", transport: undefined, command: "npx", args: ["-y","mcp-wayback-machine"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y mcp-wayback-machine", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "arxiv", label: "arXiv", description: "Search papers, download PDFs and build citation graphs — activate for academic research lookups.", category: "Search & Research", transport: undefined, command: "uvx", args: ["arxiv-mcp-server"], envKeys: ["ARXIV_MAX_RESULTS"], keyGetUrl: undefined, keyGetLabel: "(optional) max results", dependency: "uvx arxiv-mcp-server (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "newsapi", label: "NewsAPI", description: "Return top headlines and search live news — activate when researching current events.", category: "Search & Research", transport: undefined, command: "npx", args: ["-y","newsapi-mcp"], envKeys: ["NEWSAPI_KEY"], keyGetUrl: undefined, keyGetLabel: "NewsAPI key (newsapi.org)", dependency: "npx -y newsapi-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "scholar", label: "Google Scholar", description: "Search Google Scholar for papers and citations — activate when you need academic sources.", category: "Search & Research", transport: undefined, command: "uvx", args: ["mcp-scholaris"], envKeys: ["SCHOLAR_MAX_RESULTS"], keyGetUrl: undefined, keyGetLabel: "(optional) max results", dependency: "uvx mcp-scholaris (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "tavily", label: "Tavily (AI Search)", description: "AI-tuned web search, structured relevant results — activate when needing current web information.", category: "Search & Research", transport: undefined, command: "npx", args: ["-y","tavily-mcp@latest"], envKeys: ["TAVILY_API_KEY"], keyGetUrl: "https://app.tavily.com", keyGetLabel: "Get TAVILY_API_KEY", dependency: "npx -y tavily-mcp@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "exa", label: "Exa (Research)", description: "Semantic web search for research — papers, docs, live content — activate for research-grade search.", category: "Search & Research", transport: undefined, command: "npx", args: ["-y","exa-mcp-server"], envKeys: ["EXA_API_KEY"], keyGetUrl: "https://exa.ai", keyGetLabel: "Get EXA_API_KEY", dependency: "npx -y exa-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "wikipedia", label: "Wikipedia", description: "Full-text Wikipedia search and article summaries — activate when the task needs reference facts.", category: "Search & Research", transport: undefined, command: "uvx", args: ["mcp-server-wikipedia"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "uvx mcp-server-wikipedia (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "arc", label: "Arc (Code Search)", description: "Semantic code search across GitHub for APIs/patterns — activate when finding real-world code examples.", category: "Search & Research", transport: undefined, command: "npx", args: ["-y","arc-mcp"], envKeys: ["ARCTIC_API_KEY"], keyGetUrl: "https://arc.io", keyGetLabel: "Get ARIO (Arc) API key", dependency: "npx -y arc-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Productivity & PM",
    entries: [
      entry({ name: "obsidian", label: "Obsidian", description: "Read, search and write notes in an Obsidian vault — activate for note vault management.", category: "Productivity & PM", transport: undefined, command: "npx", args: ["-y","mcp-obsidian"], envKeys: ["OBSIDIAN_VAULT_PATH"], keyGetUrl: undefined, keyGetLabel: "Absolute vault path", dependency: "npx -y mcp-obsidian", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "evernote", label: "Evernote", description: "Create, search and edit Evernote notes — activate for Evernote note management.", category: "Productivity & PM", transport: undefined, command: "npx", args: ["-y","@verygoodplugins/mcp-evernote"], envKeys: ["EVERNOTE_API_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Evernote API token", dependency: "npx -y @verygoodplugins/mcp-evernote", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "asana", label: "Asana", description: "Create and update Asana tasks, projects and portfolios — activate for Asana project tracking.", category: "Productivity & PM", transport: undefined, command: "npx", args: ["-y","@jtalk22/asana-mcp"], envKeys: ["ASANA_PAT"], keyGetUrl: undefined, keyGetLabel: "Asana personal access token", dependency: "npx -y @jtalk22/asana-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "todoist", label: "Todoist", description: "Create tasks and projects, manage to-do list — activate when tracking work in Todoist.", category: "Productivity & PM", transport: undefined, command: "npx", args: ["-y","todoist-mcp-server"], envKeys: ["TODOIST_API_TOKEN"], keyGetUrl: "https://todoist.com/app/settings/integrations/developer", keyGetLabel: "Get TODOIST_API_TOKEN", dependency: "npx -y todoist-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "trello", label: "Trello", description: "Manage Trello boards, lists, cards, labels — activate when organizing tasks in Trello.", category: "Productivity & PM", transport: undefined, command: "npx", args: ["-y","mcp-trello"], envKeys: ["TRELLO_API_KEY","TRELLO_API_TOKEN"], keyGetUrl: "https://trello.com/power-ups/admin", keyGetLabel: "Trello API key + token", dependency: "npx -y mcp-trello", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "jira-cloud", label: "Jira", description: "JQL search, issue retrieval, sprint views for Jira — activate when working with Jira Cloud tickets.", category: "Productivity & PM", transport: undefined, command: "npx", args: ["-y","jira-mcp"], envKeys: ["JIRA_INSTANCE_URL","JIRA_USER_EMAIL","JIRA_API_KEY"], keyGetUrl: "https://id.atlassian.com/manage-profile/security/api-tokens", keyGetLabel: "Get JIRA_API_KEY", dependency: "npx -y jira-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "monday", label: "Monday.com", description: "Interact with Monday.com boards, items and updates — activate for Monday.com workflows.", category: "Productivity & PM", transport: undefined, command: "uvx", args: ["pm-mcp-servers"], envKeys: ["MONDAY_API_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Monday.com API token", dependency: "uvx pm-mcp-servers (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "notion-mcp", label: "Notion", description: "Search/read/write Notion pages, databases, comments — activate when working with Notion workspaces.", category: "Productivity & PM", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.notion.com)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.notion.com/mcp"),
      entry({ name: "linear-mcp", label: "Linear", description: "Create/manage Linear issues, cycles, roadmaps — activate when tracking work in Linear.", category: "Productivity & PM", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · OAuth (mcp.linear.app)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.linear.app/mcp"),
    ],
  },

  {
    label: "Data Science & ML",
    entries: [
      entry({ name: "huggingface", label: "Hugging Face", description: "Explore HF models, datasets, pipelines, inference API — activate for ML model research.", category: "Data Science & ML", transport: undefined, command: "npx", args: ["-y","huggingface-mcp-server"], envKeys: ["HF_TOKEN"], keyGetUrl: "https://huggingface.co/settings/tokens", keyGetLabel: "Get HF_TOKEN", dependency: "npx -y huggingface-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "jupyter", label: "Jupyter", description: "Run Jupyter notebooks, execute cells, read outputs — activate for data-science/notebook tasks.", category: "Data Science & ML", transport: undefined, command: "uvx", args: ["mcp-server-jupyter"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "uvx mcp-server-jupyter (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "bigquery-ml", label: "BigQuery ML", description: "Query BigQuery and run ML models — activate when doing ML analytics on BigQuery data.", category: "Data Science & ML", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · Manual OAuth (bigquery.googleapis.com)", remote: true, manualOAuth: true, oauthScopes: undefined}, "https://bigquery.googleapis.com/mcp"),
    ],
  },

  {
    label: "Media & Content",
    entries: [
      entry({ name: "youtube", label: "YouTube Transcripts", description: "Fetch YouTube transcripts, captions, video metadata — activate when summarizing video content.", category: "Media & Content", transport: undefined, command: "npx", args: ["-y","yt-transcript-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y yt-transcript-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "spotify", label: "Spotify", description: "Search music, build playlists, fetch track metadata — activate when working with Spotify.", category: "Media & Content", transport: undefined, command: "uvx", args: ["spotify-mcp"], envKeys: ["SPOTIFY_CLIENT_ID","SPOTIFY_CLIENT_SECRET"], keyGetUrl: "https://developer.spotify.com/dashboard", keyGetLabel: "Get Spotify client credentials", dependency: "uvx spotify-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Finance & Crypto",
    entries: [
      entry({ name: "yahoo-finance", label: "Yahoo Finance", description: "Fetch quotes, history, financials and options — activate for stock and market data.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","yahoo-finance-mcp-server"], envKeys: ["YAHOO_FINANCE_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Yahoo Finance API key", dependency: "npx -y yahoo-finance-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "coinbase", label: "Coinbase", description: "Check balances, send transactions and query onchain data — activate for Coinbase and crypto.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","@codespar/mcp-coinbase-cdp"], envKeys: ["CDP_API_KEY_NAME","CDP_API_KEY_PRIVATE_KEY"], keyGetUrl: undefined, keyGetLabel: "Coinbase CDP key + secret", dependency: "npx -y @codespar/mcp-coinbase-cdp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "quickbooks", label: "QuickBooks", description: "Manage invoices, bills, customers and accounts — activate for QuickBooks accounting.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","quickbooks-mcp"], envKeys: ["QUICKBOOKS_CLIENT_ID","QUICKBOOKS_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "QuickBooks OAuth credentials", dependency: "npx -y quickbooks-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "etherscan", label: "Etherscan", description: "Ethereum balances, transactions and contracts — activate for on-chain lookups.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","etherscan-mcp-server"], envKeys: ["ETHERSCAN_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Etherscan API key", dependency: "npx -y etherscan-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "paypal", label: "PayPal", description: "Create payments and inspect PayPal transactions — activate for PayPal payments.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","@paypal/mcp"], envKeys: ["PAYPAL_CLIENT_ID","PAYPAL_CLIENT_SECRET"], keyGetUrl: undefined, keyGetLabel: "PayPal REST credentials", dependency: "npx -y @paypal/mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "twilio", label: "Twilio", description: "Send SMS and WhatsApp via Twilio — activate when messaging via Twilio.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","@codespar/mcp-twilio"], envKeys: ["TWILIO_ACCOUNT_SID","TWILIO_AUTH_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Twilio account sid + token", dependency: "npx -y @codespar/mcp-twilio", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "woocommerce", label: "WooCommerce", description: "Manage WooCommerce products, orders and customers — activate for e-commerce store data.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","@wppoland/woocommerce-mcp"], envKeys: ["WC_CONSUMER_KEY","WC_CONSUMER_SECRET","WC_URL"], keyGetUrl: undefined, keyGetLabel: "WooCommerce key/secret + URL", dependency: "npx -y @wppoland/woocommerce-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "stripe", label: "Stripe", description: "Manage payments, customers, products, subscriptions — activate when working with Stripe billing.", category: "Finance & Crypto", transport: undefined, command: "npx", args: ["-y","@stripe/mcp"], envKeys: ["STRIPE_SECRET_KEY"], keyGetUrl: "https://dashboard.stripe.com/apikeys", keyGetLabel: "Get STRIPE_SECRET_KEY", dependency: "npx -y @stripe/mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "binance", label: "Binance", description: "Market data, order placement and balances on Binance — activate for Binance trading.", category: "Finance & Crypto", transport: undefined, command: "uvx", args: ["binance-mcp"], envKeys: ["BINANCE_API_KEY","BINANCE_API_SECRET"], keyGetUrl: undefined, keyGetLabel: "Binance API key/secret", dependency: "uvx binance-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
    ],
  },

  {
    label: "Security & Auth",
    entries: [
      entry({ name: "keycloak", label: "Keycloak", description: "Manage Keycloak users, realms, clients and roles — activate for Keycloak administration.", category: "Security & Auth", transport: undefined, command: "npx", args: ["-y","mcp-keycloak-admin"], envKeys: ["KEYCLOAK_URL","KEYCLOAK_REALM","KEYCLOAK_CLIENT_ID"], keyGetUrl: undefined, keyGetLabel: "Keycloak URL + credentials", dependency: "npx -y mcp-keycloak-admin", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "virustotal", label: "VirusTotal", description: "Scan files, URLs and hashes for threats — activate when checking malware and phishing.", category: "Security & Auth", transport: undefined, command: "npx", args: ["-y","@burtthecoder/mcp-virustotal"], envKeys: ["VIRUSTOTAL_KEY"], keyGetUrl: undefined, keyGetLabel: "VirusTotal API key", dependency: "npx -y @burtthecoder/mcp-virustotal", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "hackerone", label: "HackerOne", description: "Fetch HackerOne reports, programs and scope — activate for bug bounty triage.", category: "Security & Auth", transport: undefined, command: "npx", args: ["-y","hackerone-mcp"], envKeys: ["HACKERONE_API_KEY"], keyGetUrl: undefined, keyGetLabel: "HackerOne API key", dependency: "npx -y hackerone-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "auth0", label: "Auth0", description: "Manage Auth0 tenants, users, clients, rules — activate when configuring authentication/authorization.", category: "Security & Auth", transport: undefined, command: "npx", args: ["-y","@auth0/auth0-mcp-server"], envKeys: ["AUTH0_DOMAIN","AUTH0_MANAGEMENT_CLIENT_ID","AUTH0_MANAGEMENT_CLIENT_SECRET"], keyGetUrl: "https://manage.auth0.com/dashboard/", keyGetLabel: "Auth0 Management API app", dependency: "npx -y @auth0/auth0-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "1password", label: "1Password", description: "Read/write 1Password vault entries securely — activate when storing or retrieving secrets.", category: "Security & Auth", transport: undefined, command: "npx", args: ["-y","@takescake/1password-mcp"], envKeys: ["OP_SERVICE_ACCOUNT_TOKEN"], keyGetUrl: "https://my.1password.com/settings/developer", keyGetLabel: "Create a 1Password Service Account", dependency: "npx -y @takescake/1password-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "shodan", label: "Shodan", description: "Search internet-exposed devices and services — activate for external attack surface analysis.", category: "Security & Auth", transport: undefined, command: "uvx", args: ["shodan-mcp"], envKeys: ["SHODAN_API_KEY"], keyGetUrl: undefined, keyGetLabel: "Shodan API key", dependency: "uvx shodan-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
    ],
  },

  {
    label: "Monitoring & Uptime",
    entries: [
      entry({ name: "betterstack", label: "Better Stack Logs", description: "Monitor uptime and query live logs from Better Stack — activate when tailing LogTail data.", category: "Monitoring & Uptime", transport: undefined, command: "npx", args: ["-y","@blaze-money/betterstack-logs-mcp"], envKeys: ["BETTERSTACK_ACCESS_TOKEN"], keyGetUrl: "https://betterstack.com", keyGetLabel: "Get BETTERSTACK_ACCESS_TOKEN", dependency: "npx -y @blaze-money/betterstack-logs-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "zabbix", label: "Zabbix", description: "Query Zabbix hosts, triggers, problems and alerts — activate when monitoring infrastructure.", category: "Monitoring & Uptime", transport: undefined, command: "uvx", args: ["mcp-zabbix"], envKeys: ["ZABBIX_URL","ZABBIX_USER","ZABBIX_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "Zabbix URL + login", dependency: "uvx mcp-zabbix (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "pagerduty", label: "PagerDuty", description: "Manage incidents, on-call schedules and responders — activate when triaging incidents.", category: "Monitoring & Uptime", transport: undefined, command: "uvx", args: ["pagerduty-mcp"], envKeys: ["PAGERDUTY_API_TOKEN"], keyGetUrl: undefined, keyGetLabel: "PagerDuty v2 API token", dependency: "uvx pagerduty-mcp (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "uptimekuma", label: "Uptime Kuma", description: "Manage Uptime Kuma monitors, notifications, status pages — activate for self-hosted uptime checks.", category: "Monitoring & Uptime", transport: undefined, command: "npx", args: ["-y","@davidfuchs/mcp-uptime-kuma"], envKeys: ["KUMA_URL","KUMA_USERNAME","KUMA_PASSWORD"], keyGetUrl: "https://github.com/davidfuchs/mcp-uptime-kuma", keyGetLabel: "KUMA_URL + login (2FA: use API key)", dependency: "npx -y @davidfuchs/mcp-uptime-kuma", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Translation & Language",
    entries: [
      entry({ name: "deepl", label: "DeepL", description: "Accurate translations across many languages via DeepL — activate when translating content.", category: "Translation & Language", transport: undefined, command: "npx", args: ["-y","deepl-mcp-server"], envKeys: ["DEEPL_API_KEY"], keyGetUrl: "https://www.deepl.com/pro-api", keyGetLabel: "Get DEEPL_API_KEY", dependency: "npx -y deepl-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Forms & Surveys",
    entries: [
      entry({ name: "airtable", label: "Airtable", description: "Read/write Airtable bases, tables, records, fields — activate for data organized in Airtable.", category: "Forms & Surveys", transport: undefined, command: "npx", args: ["-y","@airtable/mcp-cli"], envKeys: ["AIRTABLE_API_KEY","AIRTABLE_BASE_ID"], keyGetUrl: "https://airtable.com/create/tokens", keyGetLabel: "Get AIRTABLE_API_KEY", dependency: "npx -y @airtable/mcp-cli", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Home & IoT",
    entries: [
      entry({ name: "homeassistant", label: "Home Assistant", description: "Control smart home devices — lights, switches, sensors — activate for home-automation tasks.", category: "Home & IoT", transport: undefined, command: "npx", args: ["-y","home-assistant-mcp"], envKeys: ["HOME_ASSISTANT_URL","HOME_ASSISTANT_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Home Assistant URL + long-lived token", dependency: "npx -y home-assistant-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Utilities & System",
    entries: [
      entry({ name: "pdf", label: "PDF Processor", description: "Merge, split, extract and render PDF documents locally — activate for PDF file operations.", category: "Utilities & System", transport: undefined, command: "npx", args: ["-y","@dicepdf/mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @dicepdf/mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "open-meteo", label: "Open-Meteo", description: "Current weather, forecasts and air quality data — activate when tasks need weather data.", category: "Utilities & System", transport: undefined, command: "npx", args: ["-y","open-meteo-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y open-meteo-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "system", label: "System Info", description: "Read CPU, RAM, disk, network, OS info — activate when hardware/system-resource data is required.", category: "Utilities & System", transport: undefined, command: "npx", args: ["-y","mcp-system-info"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y mcp-system-info", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "timezone", label: "Timezone", description: "Resolve timezones, offsets, DST for any city — activate when scheduling across time zones.", category: "Utilities & System", transport: undefined, command: "npx", args: ["-y","@mukundakatta/timezone-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @mukundakatta/timezone-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "spreadsheet", label: "Spreadsheet", description: "Read and edit xlsx and csv using SQL — activate when analyzing spreadsheet data.", category: "Utilities & System", transport: undefined, command: "uvx", args: ["mcp-server-spreadsheet"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "uvx mcp-server-spreadsheet (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "excel", label: "Excel (Graph)", description: "Read and write Excel workbooks via Microsoft Graph — activate for Excel data manipulation.", category: "Utilities & System", transport: undefined, command: "uvx", args: ["mcp-office"], envKeys: ["MICROSOFT_APPLICATION_ID","TENANT_ID","EXCEL_WORKBOOK_ID"], keyGetUrl: undefined, keyGetLabel: "Microsoft app + workbook id", dependency: "uvx mcp-office (needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
    ],
  },

  {
    label: "Design & Creative",
    entries: [
      entry({ name: "figma", label: "Figma", description: "Read Figma files, frames, components via API token — activate when building from designs.", category: "Design & Creative", transport: undefined, command: "npx", args: ["-y","figma-mcp-server"], envKeys: ["FIGMA_API_KEY"], keyGetUrl: "https://www.figma.com/developers/api#access-tokens", keyGetLabel: "Get FIGMA_API_KEY", dependency: "npx -y figma-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "seo", label: "SEO Analyzer", description: "Analyze pages for SEO, accessibility, core web vitals — activate when optimizing page rankings.", category: "Design & Creative", transport: undefined, command: "npx", args: ["-y","seo-mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y seo-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "recraft", label: "Recraft (AI Images)", description: "Generate/edit images from text prompts — activate when creating AI image assets.", category: "Design & Creative", transport: undefined, command: "npx", args: ["-y","recraft-mcp-server"], envKeys: ["RECRAFT_API_KEY"], keyGetUrl: "https://www.recraft.ai", keyGetLabel: "Get RECRAFT_API_KEY", dependency: "npx -y recraft-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Frontend & UI",
    entries: [
      entry({ name: "shadcn", label: "shadcn/ui", description: "Browse, search and install official shadcn/ui registry components — activate when building React UI from shadcn components.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","shadcn@latest","mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y shadcn@latest mcp (run `shadcn mcp init` once first)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "shadcn-studio", label: "shadcn Studio", description: "Insightful shadcn/ui component and registry access (freemium, no key) — activate when styling shadcn-based UIs.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","shadcn-studio-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y shadcn-studio-mcp (freemium; pro needs API_KEY+EMAIL)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "magicui", label: "Magic UI", description: "Official Magic UI registry: marquee, bento grid, glow, animated components — activate when adding Magic UI components or animations.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","@magicuidesign/mcp@latest"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @magicuidesign/mcp@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "21st", label: "21st (Magic MCP)", description: "Search, generate and install polished UI components from 21st.dev — activate when crafting production-grade component libraries.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","@21st-dev/magic@latest"], envKeys: ["API_KEY_21ST"], keyGetUrl: "https://21st.dev/mcp", keyGetLabel: "Get API_KEY_21ST", dependency: "npx -y @21st-dev/magic@latest (free key at 21st.dev/mcp)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "vuetify", label: "Vuetify", description: "Official Vuetify MCP: components, props, docs for Material Vue — activate when building Vue apps with Vuetify.", category: "Frontend & UI", transport: "http", command: "", args: [], envKeys: ["VUETIFY_API_KEY"], keyGetUrl: "https://github.com/vuetifyjs/mcp#local-installation", keyGetLabel: "Get VUETIFY_API_KEY (optional — key unlocks Bin/Play; /mcp works without it)", dependency: "Remote · Bearer token (mcp.vuetifyjs.com/mcp)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.vuetifyjs.com/mcp"),
      entry({ name: "ui-skills", label: "ui-skills", description: "Browse, search and fetch UI skills from the ui-skills registry (list_skills, get_skill) — activate when a design-engineering skill or UI pattern is needed.", category: "Frontend & UI", transport: "http", command: "", args: [], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Remote · no auth (www.ui-skills.com/mcp)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://www.ui-skills.com/mcp"),
      entry({ name: "iconify", label: "Iconify", description: "Search 200k+ icons from 150+ sets with framework snippets — activate when the UI needs a specific icon.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","iconify-mcp@latest"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y iconify-mcp@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mcp-universal-icons", label: "Universal Icons", description: "60k+ SVG icons (lucide, heroicons, tabler) with Tailwind class injection — activate when generating icon SVG/JSX for UI.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","mcp-universal-icons"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y mcp-universal-icons", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "lucide-icons", label: "Lucide Icons", description: "Lucide icon search with SVG and framework code examples — activate when using lucide icons in UI.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","lucide-icons-mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y lucide-icons-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "v0", label: "v0 (Vercel)", description: "Generate and iterate production React/Next.js UI via v0 — activate when scaffolding components quickly.", category: "Frontend & UI", transport: "http", command: "", args: [], envKeys: ["V0_API_KEY"], keyGetUrl: "https://v0.dev/login", keyGetLabel: "Get V0_API_KEY (v0.dev → Settings → API Keys)", dependency: "Remote · Bearer token (mcp.v0.dev)", remote: true, manualOAuth: undefined, oauthScopes: undefined}, "https://mcp.v0.dev"),
      entry({ name: "next-devtools", label: "next-devtools", description: "Next.js dev-server diagnostics: runtime errors, routes, perf — activate when debugging a Next.js UI.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","next-devtools-mcp@latest"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y next-devtools-mcp@latest (Next.js 16 dev server)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mui", label: "MUI (Material UI)", description: "Official MUI docs, props and code examples for Material UI / MUI X — activate when building React UIs with MUI components.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","@mui/mcp@latest"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @mui/mcp@latest", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "antd", label: "Ant Design", description: "Official Ant Design CLI: list components, props, demos, tokens, changelog — activate when building with Ant Design.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","@ant-design/cli","mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @ant-design/cli mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "chakra-ui", label: "Chakra UI", description: "Official Chakra UI v3 server: components, props, examples, theme tokens, v2→v3 guidance — activate when building with Chakra UI.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","@chakra-ui/react-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @chakra-ui/react-mcp (optional CHAKRA_PRO_API_KEY for Pro blocks)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "mantine", label: "Mantine", description: "Official Mantine docs server: components, props, styling and examples — activate when building with Mantine.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","@mantine/mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @mantine/mcp-server (docs; premium blocks need a Mantine API key)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "tailwindcss", label: "Tailwind CSS", description: "Tailwind utilities, colors, config guides and CSS→Tailwind conversion — activate when styling UIs with Tailwind classes.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","tailwindcss-mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y tailwindcss-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "shadcn-ui", label: "shadcn/ui v4 (Blocks)", description: "shadcn/ui v4 blocks, demos and component source for React, Svelte, Vue, RN — activate when crafting shadcn components or blocks.", category: "Frontend & UI", transport: undefined, command: "npx", args: ["-y","shadcn-ui-mcp-server"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y shadcn-ui-mcp-server (optional GitHub token for rate limits)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "agent-skills-frontend", label: "Agent Skills — Frontend", description: "Frontend/UI engineering skills (frontend-ui-engineering, browser-testing-with-devtools, performance-optimization, code-review-and-quality) — activate when building UIs, browser-testing, or tuning frontend performance.", category: "Frontend & UI", transport: undefined, command: "node", args: ["{SM_REPO_ROOT}/server/agent-skills/mcp/server.mjs","--domain=frontend"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "Bundled · node server/agent-skills/mcp/server.mjs --domain=frontend", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "Shopping & Dining",
    entries: [
      entry({ name: "amazon", label: "Amazon", description: "Search/buy products via Amazon scraper — activate when researching products or prices.", category: "Shopping & Dining", transport: undefined, command: "uv", args: ["run","--no-project","--with","amazon-mcp","--with","mcp<2","python3","-c","from amazon_mcp.server import mcp; mcp.run(transport='stdio')"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "uv run --no-project --with amazon-mcp (stdio; needs Python/uv)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "shopify", label: "Shopify", description: "Manage Shopify products, orders, customers, inventory — activate when working with a Shopify store.", category: "Shopping & Dining", transport: undefined, command: "npx", args: ["-y","@ajackus/shopify-mcp-server"], envKeys: ["SHOPIFY_STORE_DOMAIN","SHOPIFY_ACCESS_TOKEN"], keyGetUrl: "https://admin.shopify.com", keyGetLabel: "Get SHOPIFY_STORE_DOMAIN + admin API token (Settings → Apps → Develop apps)", dependency: "npx -y @ajackus/shopify-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
      entry({ name: "opentable", label: "OpenTable", description: "Search restaurants, check live table availability — activate for restaurant/dining research.", category: "Shopping & Dining", transport: undefined, command: "npx", args: ["-y","opentable-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y opentable-mcp (needs Node 20+ and Chrome)", remote: undefined, manualOAuth: undefined, oauthScopes: undefined}, null),
    ],
  },

  {
    label: "News & Social",
    entries: [
      entry({ name: "bluesky", label: "Bluesky", description: "Post, search and browse Bluesky feeds — activate for Bluesky social media.", category: "News & Social", transport: undefined, command: "npx", args: ["-y","@cyanheads/bluesky-mcp-server"], envKeys: ["BSKY_HANDLE","BSKY_PASSWORD"], keyGetUrl: undefined, keyGetLabel: "Bluesky handle + app password", dependency: "npx -y @cyanheads/bluesky-mcp-server", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "hackernews", label: "Hacker News", description: "Read top and recent Hacker News stories and comments — activate for Hacker News content.", category: "News & Social", transport: undefined, command: "npx", args: ["-y","@unclick/hackernews-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @unclick/hackernews-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "reddit", label: "Reddit", description: "Browse Reddit posts, comments and subreddits — activate for Reddit content.", category: "News & Social", transport: undefined, command: "npx", args: ["-y","mcp-server-reddit"], envKeys: ["CLIENT_ID","CLIENT_SECRET","USER_AGENT"], keyGetUrl: undefined, keyGetLabel: "Reddit app credentials", dependency: "npx -y mcp-server-reddit", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "mastodon", label: "Mastodon", description: "Post and read toots on any Mastodon instance — activate for fediverse activity.", category: "News & Social", transport: undefined, command: "npx", args: ["-y","mastodon-mcp"], envKeys: ["MASTODON_INSTANCE","MASTODON_TOKEN"], keyGetUrl: undefined, keyGetLabel: "Instance URL + access token", dependency: "npx -y mastodon-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
      entry({ name: "instagram", label: "Instagram", description: "Fetch public Instagram profiles and post feeds — activate for Instagram research.", category: "News & Social", transport: undefined, command: "npx", args: ["-y","@hasdata/instagram-mcp"], envKeys: [], keyGetUrl: undefined, keyGetLabel: undefined, dependency: "npx -y @hasdata/instagram-mcp", remote: undefined, manualOAuth: undefined, oauthScopes: undefined }, null),
    ],
  },
];

/** Unique category labels across the whole stock catalog (stable order). */
export function listStockCategories(): string[] {
  return MCP_STOCK_CATEGORIES.map((c) => c.label);
}

/** Total number of stock items in the catalog. */
export function countStock(): number {
  return MCP_STOCK_CATEGORIES.reduce((n, c) => n + c.entries.length, 0);
}

/** Flattened stock items, each tagged with its category. */
export function flattenStock(): McpStockEntry[] {
  return MCP_STOCK_CATEGORIES.flatMap((c) => c.entries);
}

/** Stock entry with a given name (case-insensitive), or undefined. */
export function findStockEntry(name: string): McpStockEntry | undefined {
  const lower = name.trim().toLowerCase();
  return flattenStock().find((e) => e.name.toLowerCase() === lower);
}

/**
 * Stock servers that are BUNDLED + keyless (no keys/OAuth/remote setup) and
 * therefore auto-provisioned (added + enabled) so the agent can start them
 * during a run without pausing on request_mcp_approval. These are the
 * agent-skills MCPs the system prompt marks MANDATORY per coding domain.
 */
export const AUTO_PROVISIONED_STOCK_SERVERS = [
  'agent-skills-backend',
  'agent-skills-frontend',
  'agent-skills-devops',
  'agent-skills-qa',
] as const;


