/**
 * Sub-context system — a context feeder for the agent loop.
 *
 * Core rules stay in the MAIN system prompt. Deep, situation-specific guidance
 * lives in SUB-CONTEXTS the model opens/closes via the `context_manage` tool as
 * the task's context shifts.
 *
 * Rules:
 *  - At most MAX_ACTIVE_CONTEXTS open at once.
 *  - Opening when full requires closing one first (swap).
 *  - Active contexts cost tokens — close them when the work ends.
 */

import { flattenStock } from '../../mcp/mcp-stock';

export const MAX_ACTIVE_CONTEXTS = 10;
export const MAX_ACTIVE_MCP = 5;
/** Display budget for the "required for current task" MCP list. */
export const MAX_MCP_RECOMMEND = 5;

/**
 * Category-wise stock-MCP activation roadmap. Maps each stock catalog category
 * to the concrete server names the agent should activate for that domain (via
 * context_manage as mcp_<name>). `role` is the "activate when" trigger copied
 * from the catalog description. The rendered panel annotates each server with
 * its LIVE status (configured-active / configured-disabled / stock) and whether
 * it needs keys (from the stock entry's envKeys / OAuth metadata).
 */
const STOCK_MCP_ACTIVATION_BY_CATEGORY: ReadonlyArray<{
  category: string;
  servers: ReadonlyArray<{ name: string; role: string }>;
}> = [
  { category: 'Frontend & UI', servers: [
    { name: 'ui-skills', role: 'fetch UI skills / design patterns' },
    { name: 'shadcn', role: 'add shadcn/ui registry components' },
    { name: 'shadcn-ui', role: 'shadcn v4 blocks & component source' },
    { name: 'shadcn-studio', role: 'shadcn styling insights' },
    { name: 'magicui', role: 'Magic UI animated components' },
    { name: 'agent-skills-frontend', role: 'frontend/UI skills (frontend-ui, browser-testing, a11y, perf)' },
  ] },
  { category: 'Web & Scraping', servers: [
    { name: 'playwright-mcp', role: 'browser E2E / verify UI' },
    { name: 'chrome-devtools', role: 'browser debugging + DOM' },
    { name: 'browserbase', role: 'cloud headed browser' },
    { name: 'puppeteer', role: 'headless Chrome automation' },
    { name: 'apify', role: 'scraping actors at scale' },
    { name: 'mcp-server-firecrawl', role: 'crawl/extract sites' },
    { name: 'tavily-mcp', role: 'fresh web search' },
    { name: 'mcp-exa', role: 'semantic web/code search' },
  ] },
  { category: 'Code & Git', servers: [
    { name: 'github-mcp-server', role: 'repos/PRs/actions' },
    { name: 'gitlab-mcp-server', role: 'GitLab projects/MRs/pipelines' },
    { name: 'context7', role: 'up-to-date library docs' },
    { name: 'git-mcp', role: 'advanced git ops' },
    { name: 'filesystem-mcp', role: 'read/write/search files' },
    { name: 'typescript-sdk', role: 'sandboxed TS scripting' },
  ] },
  { category: 'Databases & Storage', servers: [
    { name: 'postgres-mcp-server', role: 'PostgreSQL SQL' },
    { name: 'mysql-mcp-server', role: 'MySQL/MariaDB SQL' },
    { name: 'mongodb-mcp-server', role: 'MongoDB collections' },
    { name: 'redis-mcp-server', role: 'cache / queue' },
    { name: 'sqlite', role: 'local SQLite files' },
    { name: 'mcp-server-sqlite', role: 'local SQLite (uvx)' },
  ] },
  { category: 'Observability & Dev Tools', servers: [
    { name: 'prometheus', role: 'PromQL metrics' },
    { name: 'grafana', role: 'dashboards / alerts' },
    { name: 'sentry-mcp-server', role: 'error triage' },
    { name: 'datadog', role: 'APM / incidents' },
    { name: 'postman', role: 'API test suites' },
    { name: 'agent-skills-qa', role: 'QA/testing skills (TDD, code-review, debugging)' },
  ] },
  { category: 'Communication & Productivity', servers: [
    { name: 'slack-mcp-server', role: 'chat / threads' },
    { name: 'notion-mcp-server', role: 'docs / notes / DBs' },
    { name: 'jira-mcp-server', role: 'JQL tickets' },
    { name: 'linear-mcp-server', role: 'issue tracking' },
    { name: 'teams', role: 'Microsoft Teams' },
    { name: 'discord', role: 'Discord messages' },
  ] },
  { category: 'AI & Vector Search', servers: [
    { name: 'memory-mcp', role: 'persistent knowledge memory' },
    { name: 'openrouter', role: 'extra LLM fallback' },
    { name: 'hf-inference', role: 'HF models (text/image/audio)' },
    { name: 'qdrant-mcp', role: 'vector search / RAG' },
    { name: 'pinecone-mcp', role: 'vector search / RAG' },
  ] },
  { category: 'Cloudflare', servers: [
    { name: 'cloudflare-api', role: 'DNS/Workers/R2/Zero Trust' },
  ] },
  { category: 'Hosting & Backend', servers: [
    { name: 'firebase', role: 'Auth/Firestore/Storage/functions' },
    { name: 'neon', role: 'Neon Postgres branches' },
    { name: 'wordpress', role: 'WP CMS content' },
    { name: 'sharepoint', role: 'SharePoint sites/lists' },
    { name: 'onedrive', role: 'OneDrive files' },
    { name: 'agent-skills-backend', role: 'backend/API skills (api design, security hardening, spec, TDD)' },
    { name: 'agent-skills-devops', role: 'deploy/CI-CD skills (shipping, migration, observability)' },
  ] },
  { category: 'File System & Storage', servers: [
    { name: 'filesystem-mcp', role: 'read/write/search' },
    { name: 'gdrive', role: 'Google Drive' },
    { name: 'dropbox', role: 'Dropbox' },
    { name: 's3-storage', role: 'S3 objects' },
  ] },
  { category: 'Email & Calendar', servers: [
    { name: 'gmail', role: 'read/send Gmail' },
    { name: 'gcal', role: 'Google Calendar' },
    { name: 'google-workspace', role: 'Workspace APIs' },
    { name: 'outlook', role: 'Outlook mail/calendar' },
    { name: 'sendgrid', role: 'transactional email' },
  ] },
  { category: 'Search & Research', servers: [
    { name: 'tavily', role: 'fresh web data' },
    { name: 'exa', role: 'research-grade lookup' },
    { name: 'brave-search', role: 'privacy-first search' },
    { name: 'wikipedia', role: 'encyclopedia lookups' },
    { name: 'arxiv', role: 'paper search' },
    { name: 'newsapi', role: 'news headlines' },
  ] },
  { category: 'Security & Auth', servers: [
    { name: 'keycloak', role: 'IAM / realms' },
    { name: 'auth0', role: 'identity management' },
    { name: '1password', role: 'secrets vault' },
    { name: 'shodan', role: 'device / exposure intel' },
    { name: 'virustotal', role: 'threat intel' },
  ] },
  { category: 'Monitoring & Uptime', servers: [
    { name: 'prometheus', role: 'metrics' },
    { name: 'grafana', role: 'dashboards' },
    { name: 'sentry-mcp-server', role: 'errors' },
    { name: 'betterstack', role: 'uptime / alerts' },
    { name: 'pagerduty', role: 'incident response' },
    { name: 'uptimekuma', role: 'uptime monitoring' },
  ] },
  { category: 'Design & Creative', servers: [
    { name: 'figma', role: 'Figma design tokens' },
    { name: 'recraft', role: 'image generation' },
    { name: 'seo', role: 'SEO audits' },
  ] },
  { category: 'Whiteboards & Flowcharts', servers: [
    { name: 'excalidraw', role: 'hand-drawn diagrams' },
    { name: 'mermaid', role: 'markdown diagrams' },
    { name: 'plantuml', role: 'UML diagrams' },
    { name: 'drawio', role: 'draw.io files' },
  ] },
];

export interface SubContext {
  /** Stable id used by context_manage (snake_case). */
  id: string;
  /** Human title in the panel's AVAILABLE list. */
  title: string;
  /** One-line hint (~15 words): capability/tools + when to activate. */
  summary: string;
  /** Guidance body fed into the system message when active. */
  content: string;
  /** Relative token cost class surfaced in panel lines (defaults to "medium"). */
  cost?: 'low' | 'medium' | 'high';
  /** One-liner: when this sub-context is no longer needed (close cue). */
  closeWhen?: string;
  /** Grouping label used by the compact base-prompt catalog. */
  category?: string;
  /** Always-on contexts that cannot be deactivated (must be in the initial set). */
  pinned?: boolean;
}

/**
 * Per-id display metadata applied to every static sub-context on load. Kept
 * separate from each context's `content` body so the panel/catalog layers can
 * be enriched without touching the (large) guidance bodies.
 */
const CONTEXT_META: Readonly<Record<string, Pick<SubContext, 'cost' | 'closeWhen' | 'category' | 'pinned'>>> = {
  efficient_editing: { cost: 'low', closeWhen: 'once the edit is applied and its narrow check passed', category: 'workflow' },
  common_edge_cases: { cost: 'medium', closeWhen: 'once the edge-case audit or review of the step is done', category: 'quality' },
  backend_scale: { cost: 'high', closeWhen: 'when the backend work returns to routine edits', category: 'architecture' },
  library_guide: { cost: 'medium', closeWhen: 'once the dependency is chosen and wired', category: 'workflow' },
  frontend_ui: { cost: 'high', closeWhen: 'when the current step leaves the UI layer', category: 'ui' },
  verification_rigor: { cost: 'low', closeWhen: 'after the verify/build/typecheck passed', category: 'quality' },
  todo_management: { cost: 'low', closeWhen: 'once todos are recorded and execution starts', category: 'workflow' },
  git_hygiene: { cost: 'low', closeWhen: 'after the commit/branch/merge is done', category: 'workflow' },
  debugging: { cost: 'high', closeWhen: 'when the failure is reproduced, fixed and verified', category: 'quality' },
  security: { cost: 'high', closeWhen: 'after the security posture or fix is applied', category: 'quality' },
  performance: { cost: 'medium', closeWhen: 'when the perf goal is measured or the work moves on', category: 'quality' },
  api_contract: { cost: 'medium', closeWhen: 'when the API surface is agreed or implemented', category: 'architecture' },
  data_modeling: { cost: 'medium', closeWhen: 'when the schema/migration/entity lands', category: 'architecture' },
  repository_discovery: { cost: 'low', closeWhen: 'once the relevant code paths are located', category: 'workflow' },
  terminal_mastery: { cost: 'low', closeWhen: 'after the shell command succeeds', category: 'workflow' },
  system_architecture: { cost: 'high', closeWhen: 'once the design decision is captured in code/TODO', category: 'architecture' },
  production_readiness: { cost: 'medium', closeWhen: 'when ops/deploy hardening is finished', category: 'architecture' },
  testing_strategy: { cost: 'medium', closeWhen: 'after the test plan is decided', category: 'quality' },
  code_quality: { cost: 'medium', closeWhen: 'when the review pass is complete', category: 'quality' },
  agent_operating_principles: { cost: 'high', closeWhen: 'do not auto-close — keep while you work', category: 'core', pinned: true },
  pdf_generation: { cost: 'medium', closeWhen: 'when the PDF is generated and verified', category: 'gen-ai' },
  ppt_generation: { cost: 'medium', closeWhen: 'when the deck is generated and verified', category: 'gen-ai' },
  hugging_face: { cost: 'high', closeWhen: 'once the model/media is generated or the integration is done', category: 'gen-ai' },
  excel_generation: { cost: 'medium', closeWhen: 'when the spreadsheet is generated and verified', category: 'gen-ai' },
};

export const SUBCONTEXTS: ReadonlyArray<SubContext> = [
  {
    id: 'efficient_editing',
    title: 'Efficient Editing',
    summary: 'Cheapest edit tool for surgical diffs — activate when modifying existing code.',
    content: `EFFICIENT EDITING

Edit surgically — a minimal, verifiable diff beats a rewritten file.

TOOL CHOICE (cheap → expensive):
- replace_lines — local edits with known lines.
- edit_file — surgical change: UNIQUE old_string exactly as it appears, minimal new_string. Only the match changes.
- apply_patch — multi-hunk, non-contiguous edits in one call.
- write_file — LAST resort: new files or a justified full rewrite. Never for one-line changes.

WORKFLOW:
1. Read the targeted region (offset/limit), not the whole file.
2. Identify the smallest precise edit (one hunk, unique anchor).
3. Apply with the cheapest correct tool.
4. Validate narrowly (typecheck/build/targeted test).
5. If the hunk misses, re-read and adjust — never guess.
6. Inspect git diff after meaningful edits.

SAFE EDITING:
- Preserve surrounding behavior and user changes.
- Do not reformat unrelated files.
- Do not rename public APIs, env vars, DB columns, routes, events, or config keys unless asked.
- Prefer additive, backward-compatible changes.
- Remove dead code, unused imports, debug output, temp hacks before declaring done.

NEVER:
- Full-file rewrites for single-line changes.
- Rewriting files you have not just read.
- Inventing unrequested code.
- "Fixing" unrelated style in the same diff.
- Claiming success without a real verification step.`,
  },
  {
    id: 'common_edge_cases',
    title: 'Edge Cases',
    summary: 'Guard nulls, empties, concurrency, timeouts, money boundaries — activate before implementing or reviewing logic.',
    content: `EDGE CASES

Production code lives or dies at the boundaries.

DATA & INPUT:
- Empty/whitespace strings, null/undefined, negatives, huge numbers, NaN, Infinity, 0/falsy, long strings, bad encodings.
- Malformed JSON, missing/extra fields, wrong types, unexpected enums, locale/timezone/unicode issues.
- Duplicate submits/keys, concurrency, retries, idempotency.
- Referential states: parent deleted before child, missing item, partial multi-file ops, stale caches, empty collections.

NETWORK & RESOURCES:
- Timeouts, resets, DNS failures, 429/5xx, partial responses, retries, mid-stream errors, cancellation, disconnects.
- Rate limits, token expiry/refresh, missing credentials.
- Size limits, disk-full, permission denied, missing dirs.
- Ports in use, stale processes, files moved/deleted between read/write.
- External deps unavailable at startup or during a request.

APP BOUNDARIES:
- First run / fresh DB, migrations on old data, schema drift, legacy rows.
- 0 / 1 / N item rendering.
- Unmount during in-flight request, stale async results, rapid remounts, duplicate effects.
- Browser back/forward, hard refresh, multi-tab, offline/online.
- Partial failure in multi-step flows — never re-run completed steps.
- Shell/raw commands: enforce timeouts + error handling.

When a failure is possible but unhandled, acknowledge it and handle it explicitly when cheap. Never let an edge case silently corrupt data or fake a success.`,
  },
  {
    id: 'backend_scale',
    title: 'Backend Scale & Microservices',
    summary: 'Modular feature code, messaging, resilience, Docker patterns — activate for backend/API/server or scaling.',
    content: `BACKEND SCALE & MICROSERVICES

Build modular, feature-based systems. Scale only when required. Detect and follow the project's language, framework, architecture, naming, package manager, and tests. Organize by FEATURE/DOMAIN, not layer alone.

FILES: user.service.ts, user.controller.ts, user.repository.ts, user.module.ts, user.entity.ts, create-user.dto.ts. Avoid utils.ts / helper.ts / common.ts unless justified.

MODULAR: keep controllers, services, repos, DTOs, entities, events, tests in the feature. Example: users/{user.module,user.service,user.controller,user.repository}.ts, users/dto/*, users/entities/*.

MICROSERVICES: split by domain ownership, not layers. Each service owns its data. Explicit REST/OpenAPI, gRPC/protobuf, or event contracts. Prefer stateless. Prefer a modular monolith until boundaries are proven. Gateway/BFF for auth, routing, rate limiting, correlation.

COMMS: gRPC low-latency internal, REST/OpenAPI external, NATS/JetStream fast pub/sub, Kafka high-throughput streams/replay, RabbitMQ durable queues. Always deadlines, bounded retries, jitter.

MESSAGING: Outbox for DB+event consistency. At-least-once → idempotent consumers. Include eventId, version, timestamp, producer, correlationId, causationId. Do not rely on ordering unless guaranteed. Poison messages → DLQ + documented replay.

JOBS: slow/retryable work → existing queue (BullMQ, Redis, NATS JetStream, Kafka, RabbitMQ). Workers independently restartable, horizontally scalable, idempotent, resumable, observable, bounded. Exponential backoff, bounded retries, DLQ. Never retry forever.

RESILIENCE: timeouts, retries+jitter, circuit breakers, bulkheads, rate limits, backpressure, dedupe, graceful degradation, defined cache TTL/invalidation.

OBSERVABILITY: structured logs, request/correlation IDs, latency/error/throughput/saturation/queue-depth/retry metrics, OpenTelemetry traces. Production failures must be diagnosable without a debugger.

DOCKER: detect Docker/Compose first. Reuse existing setup. If none and containerization helps, add a minimal Dockerfile + docker-compose.yml. If installed but not running, tell the user to start it. If not installed, do not assume — ask. Do not start containers until availability is confirmed. Inspect CPU/RAM/disk/running containers before heavy local infra; set limits per capacity; use profiles/optional services; never start unused services.

LOCAL AWS: prefer LocalStack over real AWS. Only the services actually used (S3, SQS, SNS, DynamoDB, Secrets Manager, Lambda, EventBridge). Minimal compose service, persistence only when useful. Env vars + documented endpoints.

TESTING (required): unit (service/business, mocked deps, user.service.spec.ts), integration (real DB/queue/repos, testcontainers, user.integration.spec.ts), API/E2E (request→controller→service→DB→response, user.e2e.spec.ts), edge/failure (invalid input, retries, timeouts, dupes, concurrency, partial failures, recovery, user.edge.spec.ts). Follow existing test placement.

VALIDATION BEFORE DONE: typecheck, lint, unit/integration/E2E/edge tests, build, Docker build/compose config if used, infra health. No stray files, dup code, unused deps, broken imports, or architecture violations.

PRINCIPLE: inspect first; follow conventions; keep code feature-based, modular, testable, scalable, resource-aware, production-ready. More services/files/infra ≠ better architecture.`,
  },
  {
    id: 'library_guide',
    title: 'Useful Libraries & Resources',
    summary: 'Find battle-tested libraries before inventing — activate when choosing or adding a dependency, then close.',
    content: `LIBRARIES & RESOURCES

Prefer battle-tested libraries. Check what the project already uses before adding.

GENERAL: zod/valibot (validation), clsx+tailwind-merge, date-fns/dayjs, uuid/ulid/nanoid, neverthrow/Effect (typed errors), lodash-es/radash (only real gaps).

BACKEND/NODE: Fastify/Express (match existing), NestJS (modules, guards, pipes, interceptors, DTOs, providers), Prisma/Drizzle/TypeORM/Kysely (project ORM), pg/mysql2, ioredis, BullMQ, pino/pino-http.

MICROSERVICES: @grpc/grpc-js + protobuf, nats.js, kafkajs, amqplib, OpenTelemetry SDKs. Use an outbox/event schema, not ad-hoc fire-and-forget.

FRONTEND/UI: React/Next/Vite (match), shadcn/ui + Radix, Tailwind, Framer Motion (purposeful), TanStack Query, Zustand/Context (keep local when possible), react-hook-form + zod, Recharts/ECharts, TanStack Table, lucide-react, @tanstack/react-virtual.

TESTING/QUALITY: Vitest/Jest, React Testing Library, Playwright/Cypress, ESLint/Prettier/Biome, Husky+lint-staged (if present), Sentry/OpenTelemetry.

SELECTION RULES:
1. Inspect package.json + lockfile first.
2. Reuse installed deps before adding.
3. Verify runtime/version compatibility.
4. Never two libs for the same job.
5. Smallest dependency surface that solves it.
6. No unrelated upgrades during feature work.
7. Read existing patterns before "standard" usage.
8. Never invent an API — inspect installed package or official docs.
9. MUST USE before adding any dep: pnpm search <name> (or npm search to match lockfile) to confirm name+version, then read the real API from node_modules/<pkg>/README or types.`,
  },
  {
    id: 'frontend_ui',
    title: 'Build Excellent UI',
    summary: 'Match stack, ship premium prod-grade UI with GSAP/Three.js/WebGL — activate for any frontend/UI task.',
    content: `BUILD EXCELLENT UI

Ship polished, premium, production-grade interfaces — not just "working" screens.

CHECK package.json FIRST: reuse installed libs; install only when needed; never two libs for the same job.
# ⭐ DEFAULT STACK: shadcn/ui (npx shadcn@latest add <c>); Radix (@radix-ui/react-*); Tailwind; Lucide (lucide-react); Motion (motion); Sonner (sonner); CVA (class-variance-authority).
# 🧩 SHADCN: button, dialog, sheet, dropdown-menu, popover, tooltip, select, command+popover (combobox), command (palette), input, textarea, form, checkbox, switch, tabs, accordion, table, card, badge, avatar, skeleton, scroll-area, separator, sidebar, resizable, context-menu, alert, alert-dialog, sonner (toast).
# 🎨 FULL UI (pick ONE): Mantine | HeroUI | MUI | AntD | Chakra | HeadlessUI | BaseUI | ReactAria.
# 🎯 ICONS: Lucide (default) | Hugeicons | Tabler | Iconify | ReactIcons.
# ✨ ANIMATION: Motion (default) | AutoAnimate | GSAP (complex timelines) | ReactSpring | Lottie.
# 📊 CHARTS: Recharts (default) | ECharts | Nivo | Tremor | Visx.
# 📋 TABLES: TanStack Table (default) | AG Grid | MUI DataGrid (MUI apps only).
# 📝 FORMS: react-hook-form + zod + @hookform/resolvers (default) | Formik (legacy).
# 🔍 SEARCH: cmdk (palette) | Fuse (fuzzy) | ReactSelect | Downshift.
# 💻 EDITORS: Monaco | CodeMirror | TipTap | Lexical.
# 📄 MARKDOWN: react-markdown + remark-gfm + shiki.
# 🖱️ DND/FILE/PANELS: @dnd-kit/core | react-resizable-panels | react-dropzone.
# 🔔 OVERLAYS: Sonner (default) | Vaul (drawer) | react-hot-toast.
# 🏆 PRIORITY: shadcn → lucide → motion → RHF+zod → TanStack Table → recharts → cmdk → fuse → monaco → react-markdown+remark-gfm+shiki → dnd-kit → resizable-panels → sonner → tiptap.

# 🚀 PREMIUM / WOW-FACTOR UI (use deliberately, never gratuitously):
- GSAP + ScrollTrigger — cinematic scroll sequences, pinning, timelines, staggered reveals. Use for hero sections, landing pages, product tours. Clean up with gsap.context() / .kill() on unmount.
- Three.js / @react-three/fiber + @react-three/drei — 3D scenes, product viewers, shader backgrounds, particle fields. Render on demand (frameloop="demand"), respect prefers-reduced-motion, cap DPR, dispose geometries/materials on unmount.
- WebGL / OGL / PixiJS — shader-driven hero backgrounds, image transitions, data viz. Use OGL for tiny shaders, PixiJS for sprite/2D scenes.
- Spline (via @splinetool/react-spline) — designer-authored 3D embeds; lazy-load, provide poster fallback.
- Lenis / @studio-freight/lenis — smooth scroll; pair with GSAP ScrollTrigger.
- Custom Design System — when shadcn/Tailwind tokens are not enough: define tokens (color, space, radius, shadow, type scale, motion) in one place, generate primitives (Button/Input/Card/Stack/Grid/Text), document variants with CVA, ship a Storybook or a /design route. Never hand-roll a second design language alongside shadcn.
- Micro-interactions — hover/press elevation, magnetic buttons, cursor followers, spring-based transitions. Every animation must communicate state, not decorate.
- Premium polish checklist: consistent 4/8px spacing grid, restrained palette (2-3 accents), tabular-nums for data, optical alignment, skeleton→content with no layout shift, prefers-reduced-motion honored, 60fps on mid-tier hardware.

DESIGN RULES: project components > shadcn > installed libs > new dep. Lucide (never emoji) for UI icons. Minimal borders, consistent spacing/radius/type. No excessive gradients, glassmorphism, glow, or decorative motion.

PROJECT CONSISTENCY: match framework, CSS approach, tokens, component lib, typography, spacing, radii, shadows, icons, interactions. Reuse primitives. One design system per feature. Compose over giant components.

COMPONENT RECIPE: small, single-responsibility, clear props; state as local as practical; separate data from presentation; semantic HTML first; shadcn/Radix when present.

LAYOUT: mobile-first, flex/grid, no brittle widths, no accidental horizontal scroll. Handle long names, big numbers, empty collections, narrow screens. Respect safe areas.

VISUAL POLISH: clear hierarchy (page → section → content → meta → action). Consistent spacing scale and color roles. Subtle borders, deliberate shadows. Hover/active/focus states that communicate. Motion reinforces state change. Dark mode via tokens if supported. Empty/loading/error states that preserve layout and tell the user what to do next.

PRO APPS: density without clutter. Primary actions obvious, secondary quiet. Progressive disclosure. Predictable keyboard/mouse. Tables/editors/dashboards optimized for scannability. Never sacrifice usability for effects.

A11Y: keyboard navigable, visible focus, sufficient contrast, correct labels/aria, logical DOM/headings, never color alone for meaning.

VERIFY UI: typecheck/build; start the app; exercise the changed flow; check console/network; verify empty/loading/error/responsive; a running check beats re-reading files.

AGENT OPERATING PRINCIPLES (always on — activate agent_operating_principles for the full body): evidence-first (inspect the running app, don't eyeball code), minimal assumptions, explicit verification per stage, professional output. Build Excellent UI means premium polish, not just "working" screens.

MCP-FIRST FOR FRONTEND/UI (activate AND follow through — the Frontend & UI category MCPs):
- mcp_ui-skills → browse UI skills (list_skills / get_skill) and follow the fetched skill for any design-engineering or UI-pattern work.
- mcp_shadcn → search/add shadcn/ui registry components (button, dialog, sidebar, …). Never hand-roll a component the registry owns.
- mcp_magicui → add Magic UI registry components/animations (marquee, bento grid, glow, shine, animated text) via the server instead of writing them from scratch.
- mcp_shadcn-ui / mcp_shadcn-studio → use when shadcn v4 blocks/insights are needed.
- mcp_browser / mcp_playwright → activate at the phase boundary to OPEN and VERIFY the built UI (click through, screenshots, console/network errors), not just read code.
Activate them with context_manage(action="activate") at the SAME phase gate as this sub-context; DEACTIVATE when the UI layer is fully verified and done.`,
  },
  {
    id: 'verification_rigor',
    title: 'Verification Rigor',
    summary: 'Pick the right proof per task — done means verified — activate before finishing or claiming success.',
    content: `VERIFICATION

"Done" means verified.

LADDER: diff → narrowest relevant check → broader checks if risky → exercise the real workflow → inspect logs/exit codes.

CODE: git diff --check, typecheck, focused test, lint when relevant, build when relevant.
API: build, start service, health endpoint, focused request, inspect status/body, inspect logs.
FRONTEND: build, start, open the route, run the workflow, check console/network, verify loading/empty/error/success.
BUG FIX: reproduce → evidence → root cause → patch → reproduce again → confirm no adjacent regression.

RULES:
- A successful edit is not a successful feature.
- Typecheck ≠ runtime. Build ≠ UX.
- Don't ask the user to run a check you can run safely yourself.
- Respect exit codes and tool error fields.
- If verification reveals a misunderstood requirement, correct the approach — don't force the patch through.`,
  },
  {
    id: 'todo_management',
    title: 'Todo / Task List Management',
    summary: 'Drive todo_write so the on-screen task list stays accurate — activate for multi-step or long tasks.',
    content: `TODO MANAGEMENT

Use todo_write to track and communicate progress.

PLAN: before multi-step work, write 3-8 action-oriented steps (understand → design → implement → verify). Add a dedicated verification step for risky changes.

UPDATE: mark completed only after verification. At most ONE in_progress. Split sub-work into items instead of hiding jobs in one. Cancel with a reason. Never leave stale items.

DON'T OVER-MANAGE: a short one-file fix may not need todos. Short plan beats speculative plan.`,
  },
  {
    id: 'git_hygiene',
    title: 'Git Safety & Hygiene',
    summary: 'Check status first, safe hygiene, never destructive without approval — activate for commits, branches, merges.',
    content: `GIT SAFETY

BEFORE modifying: git status --short; git branch --show-current; git diff --stat.

PRESERVE USER WORK: never overwrite unrelated local changes; inspect modified/conflicted files before editing; keep unrelated changes out of the diff.

NEVER without explicit authorization: git reset --hard, git clean -fd, rm -rf, destructive SQL, destructive infra ops, force-push, branch deletion.

SAFE INSPECTION: git status --short; git diff -- <file>; git diff --check; git log -n 10 --oneline; git show <commit> --stat.

COMMITS: stage only intended files; never commit secrets, tokens, .env, generated junk; concise message matching repo conventions; inspect status + staged diff first; don't commit unless the workflow requires it.

BRANCHES: don't switch when uncommitted work could be affected. Understand the tree/branch state before rebase/merge/cherry-pick. History-rewriting commands require explicit authorization.`,
  },
  {
    id: 'debugging',
    title: 'Debugging & Root Cause',
    summary: 'Diagnose root cause from failures via logs/tests — activate for bugs, crashes, errors, failing tests.',
    content: `DEBUGGING & ROOT CAUSE

A failed command is evidence. Use it to narrow the problem.

AFTER FAILURE:
1. Read the exact error + exit status.
2. Classify: code / config / dep / env / network / data / permissions / resources / race.
3. Locate the source/config/log.
4. Build the smallest hypothesis consistent with evidence.
5. Change approach or patch the real cause.
6. Re-run the same check.
7. Add a regression test when practical.

TERMINAL: don't blindly rerun. Capture context: cmd 2>&1 | tee /tmp/agent-check.log; tail -n 200 /tmp/app.log; rg -n "error|exception|failed|timeout" /tmp/app.log; lsof -nP -iTCP:<port> -sTCP:LISTEN; ss -lntp; ps aux | rg "node|npm|pnpm|java|docker"; df -h; free -h 2>/dev/null || vm_stat. Inspect env carefully — never print secrets.

NEVER: repeat the same failed command unchanged; delete/weaken tests without understanding; suppress errors for a green build; treat an errored tool response as success. When an earlier claim was wrong, say so and correct it.`,
  },
  {
    id: 'security',
    title: 'Security Best Practices',
    summary: 'Never leak secrets, validate inputs, guard API/DB/network boundaries — activate when auth or security matters.',
    content: `SECURITY

SECRETS: never hardcode/log/commit keys, JWT secrets, passwords, private keys, DB creds, cloud tokens. Read from env or the project's secret manager. Never echo .env. Redact tokens in logs and summaries.

INPUT/OUTPUT: validate + normalize all external input. Guard against SQLi, command injection, path traversal, XSS, SSRF, prototype pollution, unsafe deserialization, upload abuse. Use parameterized queries or ORM APIs — never concatenate untrusted SQL. Encode output for context. Never trust client-supplied authz/ownership.

AUTH: least privilege. Enforce authn/authz at the server boundary. Narrow token scopes. Secure session/token expiry+refresh. Don't disable checks "temporarily" unless the task authorizes a dev-only path.

FILES/TERMINAL: resolve paths against an allowed root; reject ../ escapes; avoid shell interpolation of user input; prefer argument arrays / structured process APIs; be cautious with sudo.

HTTP/API: HTTPS where applicable, sensible CORS, rate limits on abuse-sensitive endpoints, safe content types + size limits, clean 4xx/5xx without stack traces or internal paths.

DEPS: follow existing package manager + lockfile. Avoid untrusted/unmaintained packages. Never replace security libs with home-grown crypto.`,
  },
  {
    id: 'performance',
    title: 'Performance & Efficiency',
    summary: 'Avoid N+1, premature optimization, unbounded work — activate for slow, latency, or leak paths.',
    content: `PERFORMANCE

Optimize measured bottlenecks, not imagined ones.

BACKEND/DB: avoid N+1 (joins, batches, eager load). Paginate unbounded lists; cursor pagination for large sets. Select only needed columns. Index real predicates/sorts. Reuse connection pools. Cache stable reads with TTL + invalidation. EXPLAIN/ANALYZE before touching indexes.

FRONTEND: avoid needless re-renders and main-thread work. Virtualize large lists/tables. Lazy-load heavy routes/components. Don't ship huge libs for tiny features. Optimize assets. Fix accidental effect deps causing repeat fetches.

AGENT/SYSTEM: batch related inspections when safe. Search narrowly before reading whole repos. Reuse discovered paths/context. Keep context focused — never dump whole files or giant logs. Prefer deterministic, machine-readable commands.

Measure first. Preserve clarity. Keep the diff small.`,
  },
  {
    id: 'api_contract',
    title: 'API Contract Design',
    summary: 'Design versioned, validated, idempotent endpoint contracts with pagination — activate when building/consuming APIs.',
    content: `API CONTRACT

Every endpoint: clear request schema, response schema, status semantics, authz rule. Validate at every external boundary via DTO/schema.

ERRORS: consistent shape, e.g. { "error": { "code": "...", "message": "...", "details": ... } }. Distinguish validation / authz / not-found / conflict / rate-limit / internal with correct status codes.

WRITES: idempotent where retries are possible. Support Idempotency-Key or a client operation id when duplicate execution is harmful.

PAGINATION: cursor for large sets, sensible max limits.

VERSIONING: version public contracts when breaking changes are unavoidable; prefer additive, backward-compatible changes.

DOCS: OpenAPI when applicable, kept in sync.

NEVER leak raw DB errors, SQL, stack traces, framework HTML, or internal ids.

TIMEOUTS/RETRIES: define client + downstream semantics. Use request/correlation ids.

BEFORE implementing: find similar routes; reuse auth/validation/error conventions; inspect DTO patterns; inspect controller/service/repo boundaries; implement the smallest consistent contract; verify with a real request.`,
  },
  {
    id: 'data_modeling',
    title: 'Data Modeling & Migrations',
    summary: 'Model clean schema, safe migrations, money as decimals, no duplicate state — activate for database work.',
    content: `DATA MODELING & MIGRATIONS

MODEL FROM INVARIANTS: model business rules, not temporary UI shapes. One source of truth per fact. No duplicated state that can drift. Consistent naming. Stable typed ids, UTC timestamps.

CONSTRAINTS: NOT NULL, UNIQUE, FK, CHECK, sensible defaults. Choose RESTRICT/CASCADE/SET NULL deliberately. Transactions for atomic related changes. Optimistic locking or single-writer for concurrent updates.

MONEY: integer minor units or NUMERIC/DECIMAL. Never float for currency. Rounding rules explicit.

MIGRATIONS: read current schema + conventions first. Prefer additive. Backfill in bounded batches. Safe across old+new app versions during rolling updates. Don't drop/rename a column in the same deploy that breaks old code unless rollout guarantees compatibility. Include rollback/forward-recovery. Consider indexes, locks, runtime cost, replication, table size. Test against representative existing data.

INTEGRITY: FKs over app-only assumptions. Unique constraints where the invariant is real. Audit/soft-delete only when business requirements justify the complexity.`,
  },
  {
    id: 'repository_discovery',
    title: 'Repository Discovery',
    summary: 'Map the workspace fast, then follow its conventions — activate at task start before editing anything.',
    content: `REPOSITORY DISCOVERY

Never change code blindly.

FIRST PASS: pwd; git status --short; git branch --show-current; ls -la; find . -maxdepth 2 -type f | sort | head -200; tree -L 3 2>/dev/null || true.

IDENTIFY: package.json / pnpm-workspace.yaml / lockfiles; tsconfig/eslint/biome; Dockerfile/compose; README/docs; apps/ packages/ services/ src/; tests + CI; .env.example (never print real .env).

SEARCH: rg -n "symbol|route|event|error text" .; rg --files | rg "(package|tsconfig|Dockerfile|compose|README)"; fd -t f -e ts -e tsx -e js -e jsx; git log -n 10 --oneline -- <path>.

READ IN CONTEXT: find entry point; read smallest useful region; trace imports/callers/types; check siblings for patterns; inspect tests before changing behavior.

PACKAGE MANAGER: detect from lockfiles/package.json; prefer repo scripts; don't switch pnpm/npm/yarn/bun casually; never regenerate the lockfile unnecessarily.

MONOREPO: determine package ownership; find workspace boundaries; run at the narrowest scope first; understand shared code before modifying.`,
  },
  {
    id: 'terminal_mastery',
    title: 'Terminal Mastery',
    summary: 'Search, inspect, run, verify via shell — activate for discovery, builds, servers, runtime checks.',
    content: `TERMINAL WORKFLOW

Discovery → Search → Read → Hypothesize → Edit → Run → Inspect → Verify → Diff.

DISCOVERY: pwd; ls -la; tree -L 3 2>/dev/null || true; find . -maxdepth 2 -type d | sort; rg --files | head -200; fd -t f; du -sh ./* 2>/dev/null | sort -h.

SEARCH: rg -n "needle" .; rg -n --glob '!node_modules' "needle" .; rg -l "needle" .; fd "agent.*service" .; git grep -n "needle".

READ: sed -n '1,220p' <file>; sed -n '220,440p' <file>; head -n 100 <file>; tail -n 200 <file>; git show HEAD:<file>.

CONFIG: cat package.json; jq '.scripts' package.json; jq '.dependencies' package.json; jq '.workspaces' package.json; git diff -- <file>; git diff --check.

COMPOUND (keep failure semantics clear): pwd && git status --short && git branch --show-current; rg -n "needle" src && sed -n '1,220p' src/file.ts; jq '.scripts' package.json && printf '\\n---\\n' && git status --short; rg -n "TODO|FIXME|HACK" src test; git diff --check && pnpm exec tsc --noEmit.

RUN/PORTS: lsof -nP -iTCP:<port> -sTCP:LISTEN; ss -lntp; ps aux | rg "node|pnpm|npm|docker"; curl -fsS http://localhost:<port>/health; curl -i <url>; always timeout commands that may hang.

LOGS: tail -n 200 /tmp/app.log; rg -n "error|exception|fatal|timeout" /tmp/app.log; docker logs --tail 200 <c>; docker compose ps; docker compose logs --tail 200 <svc>.

NODE/TS: node -v; pnpm -v; pnpm exec tsc --noEmit; pnpm lint; pnpm test; pnpm build; pnpm why <pkg>; pnpm list --depth 0.

DB/SQL: inspect migration scripts first; prefer project scripts; read-only queries for diagnosis; never DROP/TRUNCATE/DELETE/ALTER-destructive without explicit auth + recovery plan.

DOCKER: docker ps; docker images; docker compose config; docker compose ps; docker compose logs --tail 200 <svc>; docker inspect <c>. Avoid destructive cleanup unless authorized.

SAFETY: quote paths with spaces/metachars; prefer arrays/structured process APIs over string concat in code; avoid destructive globbing; verify cwd before mutating commands; check exit codes; never expose credentials.`,
  },
  {
    id: 'system_architecture',
    title: 'System Architecture & Design',
    summary: 'Design around boundaries, contracts, state, failure modes — activate for architecture and design.',
    content: `SYSTEM ARCHITECTURE

Before non-trivial work, define: components, responsibilities, data flow, dependencies, state ownership, failure behavior.

PRINCIPLES: clear ownership > clever abstraction. Explicit contracts. Business logic independent of transport/UI where practical. Infra behind stable interfaces when likely to change. No circular deps, no hidden global state. Failures visible in the design.

BOUNDARIES: UI → API/client → application/service → repo/domain/infra → external adapters; producer → broker → idempotent consumer. Don't let every layer know every other.

STATE: for each important state — owner, writers, cache, invalidation, restart behavior, duplicate delivery, concurrent modification.

API: stable contracts, DTO/schema, authn/authz boundary, pagination + bounded payloads, consistent errors, timeouts/retry semantics.

DATA FLOW: trace one request end-to-end (client → gateway → service → DB/cache/broker → response/event) and one failure path (timeout / validation / duplicate / retry).

ASYNC: for each event/job — producer, payload/schema, id, retry policy, dedupe/idempotency, ordering assumption, DLQ, observability, replay.

CACHING: key, TTL, invalidation, stale-read tolerance, stampede protection, behavior when unavailable.

SCALING: find the bottleneck (CPU, memory, network, DB connections, lock contention, queue depth, storage, render). Scale horizontally only when state ownership permits.

SECURITY: threat-model trust boundaries. Browsers, clients, jobs, external services are untrusted unless authenticated.

DECISION RULE: don't add microservices, Redis, Kafka, a new ORM, a second state manager, or a new abstraction just because it's popular. Add infra only when the requirement and failure model justify it.

BIG FEATURE DESIGN CHECK: requirements/acceptance, reusable components, new components, data/API changes, state+event flow, failure/rollback, observability, security, test strategy, deployment/migration order.`,
  },
  {
    id: 'production_readiness',
    title: 'Production Readiness',
    summary: 'Reliability, operability, deploy safety, maintenance as part of every feature — activate before delivery.',
    content: `PRODUCTION READINESS

A feature is production-ready when it works normally, fails safely, is operable, and can change without avoidable outages.

RELIABILITY: define timeouts; bounded retries + jitter; idempotent repeats where possible; explicit partial-failure handling; no unbounded queues/memory/bodies/files/loops; fail closed for security-sensitive checks.

OPERABILITY: structured logs; useful errors; health/readiness; metrics (latency, errors, queue depth, saturation, dependency health); correlation ids; clear startup/shutdown.

DEPLOYMENT: confirm build artifacts; validate config shape; check migration compatibility with old+new app versions; expand→deploy→backfill→contract; have rollback/forward-fix.

CONFIG: validate required env vars at startup; safe defaults only when genuinely safe; isolate dev-only settings; never silently fall back to insecure prod behavior.

DEPS: pin via lockfile; no unrelated upgrades; verify native/runtime compat; note why a new dep is necessary when non-obvious.

DOCS: update the smallest relevant README/docs/config example; document migrations, env vars, worker startup, broker setup when a future engineer would otherwise have to rediscover them.

DEFINITION OF DONE: requirement met; existing behavior preserved; relevant tests pass; build/typecheck passes where applicable; runtime flow verified; logs/errors reasonable; no accidental changes; no secrets/unsafe debug output; new operational assumptions documented.`,
  },
  {
    id: 'testing_strategy',
    title: 'Testing Strategy',
    summary: 'Cheapest test that proves the behavior, then integration at boundaries — activate when writing tests.',
    content: `TESTING STRATEGY

Match the test to the risk.

UNIT: pure functions, transforms, validators, business rules, small deterministic logic.
INTEGRATION: real DB/cache/FS/queue/HTTP boundary/repo/module integration.
E2E: critical user workflows and cross-layer contracts.

TEST WHAT BREAKS: happy path; validation failures; authz failures; empty results; duplicate requests; concurrent updates where relevant; timeouts/retries; partial dependency failure; pagination boundaries; migration/backfill for affected data.

GOOD TESTS: deterministic; isolated; named after behavior; assert observable outcomes; independent of implementation unless the implementation is the contract.

AVOID: arbitrary sleeps when polling works; snapshots of huge unstable structures; mocks that duplicate the implementation; "did not throw" assertions; weakening tests to make a refactor pass.

REGRESSION: every bug fix should have a reproducible check; add a regression test when the failure can recur.

DISCOVERY: inspect package scripts, CI workflow, nearby test files; run the narrowest command first; expand based on touched boundaries.`,
  },
  {
    id: 'code_quality',
    title: 'Code Quality & Maintainability',
    summary: 'Obvious code, cohesive modules, explicit naming, low cognitive load — activate while refactoring/reviewing.',
    content: `CODE QUALITY

Write code another engineer can safely modify six months later.

STRUCTURE: cohesive modules. Abstractions proportional to real reuse. Explicit control flow when logic is complex. Names encode intent. Small focused functions/components. Separate side effects from pure logic where practical.

TYPES: strong types at boundaries. Avoid any unless documented. Reuse domain types. Explicit nullability. Narrow unions/enums over arbitrary strings.

ERRORS: handle at the layer with enough context. Preserve causal info for logs. Convert internal failures to stable external contracts. Never swallow silently.

COMMENTS: why not what. Document invariants, race-prevention, compatibility, non-obvious trade-offs. Remove comments made false by a change.

REFACTORING: don't mix large refactors with features unless necessary. Small reversible steps. Preserve behavior first, then simplify. Measure before optimizing.

MAINTAINABILITY TEST: can someone find the entry point fast? Is data flow obvious? Are error paths understandable? Is state ownership clear? Can it be tested without booting the world? Does the diff solve the requirement without unrelated churn?`,
  },
  {
    id: 'agent_operating_principles',
    title: 'Agent Operating Principles',
    summary: 'Evidence-first, minimal assumptions, explicit verification, professional output — activate for any substantial task.',
    content: `AGENT OPERATING PRINCIPLES

You are an engineering agent, not autocomplete.

BEFORE ACTION: understand the goal + acceptance criteria. Inspect the repo before inventing structure. Search for existing implementations/patterns. Identify constraints and public contracts that must not change. Prefer reuse over duplication.

EVIDENCE: repo code, package scripts, config, tests, runtime output are primary evidence. Assumptions are hypotheses until checked. When uncertain about an API or convention, inspect code/installed package/lockfile/authoritative docs. Never fabricate paths, functions, package names, commands, or behavior.

IMPLEMENTATION: smallest coherent change that satisfies the requirement. Preserve public interfaces unless the user asks for a breaking change. No unrelated cleanup. Use terminal strategically. Focused, reversible edits.

FEATURE FLOW: discover repo/architecture → acceptance criteria → find reusable parts → smallest design → focused implementation → targeted verification per stage → broader checks by risk → inspect final diff → summarize what changed, what was verified, remaining risk.

AMBIGUITY: pick the safest interpretation supported by the app. Preserve compatibility. Don't invent product behavior that changes user expectations. Surface material assumptions explicitly rather than hiding them in code.

OUTPUT: report actual commands/checks run. Mention failures and whether they were resolved. Concise but technically precise. Never claim a test passed unless it did. Never call something production-ready when important verification is missing.

NORTH STAR: reliable behavior, minimal diff, clear architecture, secure defaults, excellent UX, fast feedback loops, evidence-based verification.`,
  },
  {
    id: 'pdf_generation',
    title: 'PDF Generation',
    summary: 'Create PDFs via fpdf2/reportlab, or HTML+Playwright fallback — activate when generating PDF documents.',
    content: `PDF GENERATION

Create professional PDFs: text, tables, bullets, headings, images, structured layouts.

FILE PATH MARKER — REQUIRED IN EVERY REPLY (works for ALL generated files):
<file-SM-st>ABSOLUTE_PATH<file-sm-ed>
Examples: <file-SM-st>/Users/me/docs/report.pdf<file-sm-ed>, <file-SM-st>C:\\Users\\me\\docs\\report.pdf<file-sm-ed>

APPROACH A — PYTHON LIBRARY (PREFERRED):
1. Check: run_command("python3 --version && pip3 show fpdf2 2>/dev/null || pip3 show reportlab 2>/dev/null")
2. If missing, ASK before installing: "I need a Python PDF library. fpdf2 (lightweight, ~1MB) or reportlab (full-featured)? May I install fpdf2?" Install only after user confirms.
3. Generate with a Python script in a temp file.

PRO RULES: clean readable font (Helvetica, DejaVu for Unicode); ≥20mm margins; tables with bordered cells, bold header, zebra rows; bullets properly indented; headings larger+bold with spacing; page numbers in footer; 1.2-1.5 line spacing; 2-3 accent colors max; right-align currency/numbers; sort/format data professionally — never raw dumps.

APPROACH B — HTML + TAILWIND + PLAYWRIGHT (FALLBACK):
1. Self-contained HTML with Tailwind CDN.
2. run_command("npx playwright install chromium 2>/dev/null || true"), then a Node script: chromium.launch() → page.setContent(html) → page.pdf({ path, format:'A4', margin:{top:'20mm',bottom:'20mm',left:'20mm',right:'20mm'}, printBackground:true }) → browser.close().
3. Report the path with the marker.

APPROACH C — PURE HTML (NO DEPS): create the HTML and tell the user to open in a browser and print to PDF.

OUTPUT: state what was created (title, page count if known) and the path wrapped in <file-SM-st>path<file-sm-ed>.`,
  },
  {
    id: 'ppt_generation',
    title: 'PPT / Presentation Generation',
    summary: 'Create PPTX via python-pptx, or HTML fallback — activate when making presentations or slide decks.',
    content: `PPT / PRESENTATION GENERATION

Create professional .pptx with layouts, bullets, tables, chart placeholders, images, consistent styling.

FILE PATH MARKER — REQUIRED IN EVERY REPLY (works for ALL generated files):
<file-SM-st>ABSOLUTE_PATH<file-sm-ed>

APPROACH A — PYTHON python-pptx (PREFERRED):
1. Check: run_command("python3 -c 'import pptx; print(pptx.__version__)' 2>/dev/null || echo 'NOT_INSTALLED'")
2. If missing, ASK before installing: "I need python-pptx (the standard Python .pptx library) to create your deck. May I install it?"
3. Generate with a Python script.

PRO RULES: one consistent theme; title slide (large title + subtitle, minimal text); content slides ≤5-6 bullets, ≤2 nesting levels; tables with clean borders, bold header, sensible widths; use layouts (Title+Content, Two Column, Section Header); title 36-44pt, body 20-24pt, footnotes 12-14pt; palette of 2-3 colors reused everywhere; slide numbers in footer; speaker notes on key slides; sort data first; minimal/no transitions; images fit without stretching; 16:9 unless specified.

STRUCTURE: title → agenda/TOC → one topic per slide → summary/Q&A/next steps. Keep text scannable.

APPROACH B — HTML + TAILWIND + PLAYWRIGHT (FALLBACK): self-contained HTML deck, render pages, assemble as PDF presentation.

OUTPUT: state what was created and the path in <file-SM-st>path<file-sm-ed>.`,
  },
  {
    id: 'hugging_face',
    title: 'Hugging Face Assets & Models',
    summary: 'Generate HF video/voice/image/text after secret_manager read — activate when HF media is needed.',
    content: `HUGGING FACE ASSETS

Create real assets — video, voice/audio, images, STT, text — via HF Inference API. Cover ALL categories, not just chat.

AUTH: HF token is stored on this machine. Get it ONLY via secret_manager, ONLY after user approval. Never print/hardcode/redact everywhere. Also available as $HUGGING_FACE_TOKEN — prefer the env var, never print it. Format: hf_…. Invalid/expired → HTTP 401 → re-read the secret fresh, re-export, retry.

ENDPOINTS (old api-inference.huggingface.co is RETIRED — use router.huggingface.co):
- Chat/LLM: POST https://router.huggingface.co/v1/chat/completions — Bearer token; body { model, messages, stream }.
- Media (image/video/TTS/audio/ASR/embeddings): resolve provider → POST https://router.huggingface.co/<provider>/<providerId>.
  1) GET https://huggingface.co/api/models/<owner>/<model>?expand[]=inferenceProviderMapping → pick a "status":"live" provider, use its "providerId" (already prefixed, e.g. fal-ai/kokoro/american-english).
  2) POST https://router.huggingface.co/<provider>/<providerId> — Bearer + JSON body.
  Verified: TTS on /fal-ai/fal-ai/kokoro/american-english with {"text":"…"}.
  If {"error":"Model not supported by provider <X>"}, switch provider/model — don't retry the same call.
- Status: GET https://huggingface.co/api/whoami-v2 → 200 ok / 401 invalid.

MODEL TIERS — flag every model:
- [FREE] verified on Basic token.
- [CREDITS] needs Inference Providers credits / PRO (fal-ai, wavespeed, replicate, nscale…). When credits are gone → HTTP 402 "…depleted your monthly included credits…". Some [CREDITS] chat models 400 "model_not_supported" on Basic.
Match the run's tier: FREE → only [FREE]; PAID → full catalog; blank → assume FREE. On FREE, never call a [CREDITS] model just to try — use an available FREE model or tell the user it needs a paid token.

TEXT/LLM (POST /v1/chat/completions, body model):
- [FREE] Qwen/Qwen2.5-72B-Instruct; meta-llama/Llama-3.1-8B-Instruct.
- [CREDITS] Qwen/Qwen3-30B-A3B-Instruct-2507, Qwen/Qwen3-4B, Qwen/Qwen2.5-Coder-32B-Instruct, meta-llama/Llama-3.3-70B-Instruct, mistralai/Mistral-Small-3.2-24B-Instruct-2509, deepseek-ai/DeepSeek-R1-Distill-Qwen-32B, deepseek-ai/DeepSeek-V3, HuggingFaceTB/SmolLM2-1.7B-Instruct, google/gemma-3-27b-it.

VIDEO (text→video, body {"inputs":"prompt"}):
- [CREDITS] Wan-AI/Wan2.1-T2V-1.3B, Wan-AI/Wan2.2-TI2V-5B; Kijai/WanVideo/Wan2.1-I2V-14B (i2v), Lightricks/LTX-Video; tencent/HunyuanVideo, tencent/HunyuanVideo-1.5, THUDM/CogVideoX-5b. Output mp4/webm → wrap path.

VOICE/TTS (body {"text":"…"}, wav/mp3):
- [FREE] hexgrad/Kokoro-82M via /fal-ai/fal-ai/kokoro/american-english (VERIFIED — free even after image credits deplete).
- [CREDITS] coqui/XTTS-v2, suno/bark, myshell-ai/MeloTTS, parler-ai/parler-tts-large-v1.

AUDIO/MUSIC (body {"inputs":"…"}):
- [CREDITS] facebook/musicgen-small/-large/-melody; audioldm/audioldm2; stabilityai/stable-audio-open-1.0.

IMAGE (text→image):
- On FREE, text-to-image is effectively unavailable — say so, don't retry paid endpoints.
- On PAID: POST /fal-ai/fal-ai/fast-sdxl (VERIFIED 200) or /fal-ai/fal-ai/flux/schnell with {"prompt":"…"}. fal-ai returns JSON {"images":[{"url":"…"}]} — curl the url to save. Models: black-forest-labs/FLUX.1-schnell, FLUX.1-dev, FLUX.1-Krea-dev, stabilityai/stable-diffusion-3.5-large, sdxl-base-1.0, sdxl-turbo, kandinsky-community/kandinsky-3.1.

ASR (POST audio bytes):
- [CREDITS] openai/whisper-large-v3, whisper-large-v3-turbo, whisper-small; facebook/wav2vec2-large-960h, facebook/mms-1b-all. Returns {"text":"…"}.

VISION (image+text→text, /v1/chat/completions with image URLs):
- [CREDITS] Qwen/Qwen2.5-VL-7B-Instruct, meta-llama/Llama-3.2-11B-Vision-Instruct, llava-hf/llava-v1.6-mistral-7b.

EMBEDDINGS (body {"inputs":["…"],"parameters":{"pooling":"cls"}}):
- [CREDITS] BAAI/bge-m3, BAAI/bge-large-en-v1.5, Alibaba-NLP/gte-large-en-v1.5. (No OpenAI-compatible /v1/embeddings route.)

RULES: request user approval before any secret read and explain which/why. Never print the token. 503 "loading" / 429 → backoff+retry. Generated media paths MUST use the marker <file-SM-st>ABSOLUTE_PATH<file-sm-ed> (Windows too).`,
  },
  {
    id: 'excel_generation',
    title: 'Excel / Spreadsheet Generation',
    summary: 'Create Excel via openpyxl, CSV for simple data — activate when exporting spreadsheets or tabular data.',
    content: `EXCEL / SPREADSHEET GENERATION

Create professional .xlsx with formatted tables, multiple sheets, formulas, charts, conditional formatting, styling.

FILE PATH MARKER — REQUIRED IN EVERY REPLY (works for ALL generated files):
<file-SM-st>ABSOLUTE_PATH<file-sm-ed>

APPROACH A — PYTHON openpyxl (PREFERRED for .xlsx):
1. Check: run_command("python3 -c 'import openpyxl; print(openpyxl.__version__)' 2>/dev/null || echo 'NOT_INSTALLED'")
2. If missing, ASK: "I need openpyxl (the standard Python .xlsx library). May I install it?"
3. Generate with a Python script.

PRO RULES: header row bold, colored bg (dark blue/gray), white text, frozen panes; column widths auto-fit or sensible; number formats for currency (2dp), %, dates; thin borders on data cells, thicker table outline; text left, numbers right, headers centered; zebra rows; descriptive sheet names (not Sheet1 unless only sheet); multiple sheets for views; dropdown validation where useful; freeze header + first column; sort before writing; auto-filter on headers for large sets; SUM/AVERAGE/COUNT formulas for totals; merge cells for section headers (sparingly); conditional formatting (color scales, icons).

APPROACH B — CSV (FALLBACK): proper escaping, headers, UTF-8 BOM for Excel. Tell the user it opens in Excel/Google Sheets.

PATTERN: from openpyxl import Workbook; from openpyxl.styles import Font, PatternFill, Alignment, Border, Side; wb = Workbook(); ws = wb.active; ws.title = "Summary"; …; wb.save(output_path).

OUTPUT: state sheets, row count, features used, and the path in <file-SM-st>path<file-sm-ed>.`,
},
].map((c) => ({ ...c, ...CONTEXT_META[c.id] }));

const byId = new Map(SUBCONTEXTS.map((c) => [c.id, c]));

export function getSubContext(id: string): SubContext | undefined {
  return byId.get(id);
}

export const ALL_SUBCONTEXTS: readonly string[] = Object.freeze(SUBCONTEXTS.map((c) => c.id));

/** Empty by design — the initial set is derived from the task. */
export const DEFAULT_SUBCONTEXTS: readonly string[] = Object.freeze([]);

const TASK_CONTEXT_RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  // Hard failure class — narrow so routine "error" wording doesn't auto-open a
  // full debugging brief. Generic edge cases route to common_edge_cases.
  { id: 'debugging', re: /\b(crash(es|ed)?|traceback|stack trace|segfault|panic|unhandled (error|exception)|reproduce|null pointer|typeerror|undefined is not|is not a function|failing (test|build)|broken (build|test)|doesn'?t work|not working|stuck at)\b/i },
  { id: 'common_edge_cases', re: /\bedge case|null|empty|undefined|missing|out of (bound|range)|concurr|race condition|deadlock|timeout|time.?zone|overflow|underflow|validation|monetiz|currency|rounding|clamp|off.by.one|divide by zero|collision/i },
  { id: 'frontend_ui', re: /\bfront-end|frontend|react|vite|next\.?js|component|u\s?i\b|dashboard|landing|page\b|form\b|button|tailwind|jsx|tsx|\bhtml\b|\bcss\b|browser|gsap|three\.?js|webgl|shader|animation|motion/i },
  { id: 'backend_scale', re: /\bbackend|back-end|express|nestjs|server\b|microservice|grpc|kafka|nats|queue|cache|redis|concurr|monolith|socket|scale/i },
  { id: 'api_contract', re: /\bapi(s)?\b|swagger|openapi|endpoint|webhook|crud\b|rest(ful)?\b/i },
  { id: 'data_modeling', re: /\bdatabase|\bdb\b|\bsql\b|schema|migration|prisma|drizzle|postgres|mysql|mongodb|entity|table\b|model(s)?\b/i },
  { id: 'security', re: /\b(auth|jwt|token|password|login|oauth|injection|xss|csrf|security|sanitize)\b/i },
  { id: 'performance', re: /\bperf|optimi[sz]|slow|latency|benchmark|bundle|leak\b/i },
  { id: 'git_hygiene', re: /\bcommit|push|pull|branch|merge|rebase|\bpr\b|pull request|git\b/i },
  { id: 'library_guide', re: /\b(package|library|lib|dependency|integrat|install|set\s?up|setup|configure)\b/i },
  { id: 'verification_rigor', re: /\b(test|tests|typecheck|lint|build|verify|ci)\b/i },
  { id: 'todo_management', re: /\b(milestone|roadmap|phase[s]?|multi.step|implement (multiple|several|a few|\d)|todos?)\b/i },
  { id: 'pdf_generation', re: /\b(pdf|export.*pdf|generate.*pdf|create.*pdf|print.*pdf|save.*pdf|document|invoice|report|resume|cv|brochure)\b/i },
  { id: 'hugging_face', re: /\b(hugging\s?face|\bhf\b|inference api|transformer|diffusers|fine-?tun(e|ing)|wan[12]|hunyuan|cogvideo|ltx-video|mochi|open-sora|pyramid.?flow|xtts|kokoro|bark\b|melo.?tts|styletts|chatterbox|musicgen|audioldm|stable.?audio|flux\b|stable.?diffusion|sdxl|playground.?v2|whisper|wav2vec|text.?to.?video|text.?to.?speech|text.?to.?image|text.?to.?music|voice clone|speech synthes|video generation|image generation|generate a (image|video|voice|audio)|ai (video|voice|image|art|music))\b/i },
  { id: 'ppt_generation', re: /\b(ppt|pptx|powerpoint|presentation|slide[s]?|deck|keynote|reveal\.js)\b/i },
  { id: 'excel_generation', re: /\b(excel|xlsx|xls|spreadsheet|openpyxl|csv|workbook|worksheet|tabular|pivot|chart.*data)\b/i },
];

/**
 * Tool-group gating for recommendation: a rule id may only fire when the task's
 * tool-group set intersects its allowed groups. Ids missing from this map are
 * allowed everywhere (keep the map to groups that genuinely constrain).
 */
const GROUP_ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  efficient_editing: new Set(['editing']),
  verification_rigor: new Set(['editing', 'verification']),
  frontend_ui: new Set(['editing']),
  backend_scale: new Set(['editing']),
  git_hygiene: new Set(['git']),
  pdf_generation: new Set(['editing']),
  ppt_generation: new Set(['editing']),
  excel_generation: new Set(['editing']),
  hugging_face: new Set(['editing']),
};

export function recommendSubContextsForTask(task: string, toolGroups: ReadonlySet<string>): string[] {
  if (!toolGroups.has('editing') && !toolGroups.has('verification')) return [];
  const ids: string[] = [];
  const push = (id: string): void => {
    if (byId.has(id) && !ids.includes(id)) ids.push(id);
  };
  if (toolGroups.has('editing')) push('efficient_editing');
  if (toolGroups.has('editing') || toolGroups.has('verification')) push('verification_rigor');
  for (const rule of TASK_CONTEXT_RULES) {
    const allowed = GROUP_ALLOWED[rule.id];
    if (allowed && ![...toolGroups].some((g) => allowed.has(g))) continue;
    if (rule.re.test(task)) push(rule.id);
  }
  if (ids.length === 0) push('common_edge_cases');
  return ids.slice(0, MAX_ACTIVE_CONTEXTS);
}

/** Deterministic relevance score for the AVAILABLE ranking: rule match > token overlap. */
function relevanceScore(task: string, c: SubContext): number {
  const rule = TASK_CONTEXT_RULES.find((r) => r.id === c.id);
  let score = 0;
  if (rule && rule.re.test(task)) score += 3;
  const titleWords = new Set(c.title.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const summaryWords = new Set(c.summary.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const taskLower = task.toLowerCase();
  for (const w of titleWords) if (taskLower.includes(w)) score += 1;
  for (const w of summaryWords) if (taskLower.includes(w)) score += 1;
  return score;
}

export class SubContextManager {
  private readonly active: Set<string>;
  readonly maxActive: number;
  private readonly dynamicMap = new Map<string, SubContext>();
  private mcpActiveCount = 0;
  readonly maxActiveMcp = MAX_ACTIVE_MCP;
  /** Pinned contexts are always active and cannot be deactivated. Default: none. */
  private readonly pinned: ReadonlySet<string>;
  /** Open-count per id (thrash guard: warn after 3+ activations). */
  private readonly openCount = new Map<string, number>();
  /** Last context_manage change — surfaced as a one-line delta in the panel. */
  lastDelta: { opened: string[]; closed: string[] } | null = null;

  constructor(initial: readonly string[] = [], maxActive = MAX_ACTIVE_CONTEXTS) {
    this.maxActive = maxActive;
    this.pinned = new Set(initial.filter((id) => byId.get(id)?.pinned));
    this.active = new Set<string>();
    for (const id of initial) this.activate(id);
  }

  get pinnedIds(): readonly string[] { return [...this.pinned]; }
  isPinned(id: string): boolean { return this.pinned.has(id); }

  registerMcpServer(id: string, title: string, summary: string): void {
    this.dynamicMap.set(id, { id, title, summary, content: `MCP server "${title}": ${summary}` });
  }

  get registeredMcpIds(): string[] { return [...this.dynamicMap.keys()]; }
  isMcpContext(id: string): boolean { return this.dynamicMap.has(id); }
  resolve(id: string): SubContext | undefined { return byId.get(id) ?? this.dynamicMap.get(id); }
  get activeCount(): number { return this.active.size; }
  get activeIds(): readonly string[] { return [...this.active]; }

  get availableIds(): readonly string[] {
    const staticAvailable = SUBCONTEXTS.filter((c) => !this.active.has(c.id)).map((c) => c.id);
    const dynamicAvailable = [...this.dynamicMap.keys()].filter((id) => !this.active.has(id));
    return [...staticAvailable, ...dynamicAvailable];
  }

  isActive(id: string): boolean { return this.active.has(id); }
  knows(id: string): boolean { return byId.has(id) || this.dynamicMap.has(id); }
  /** Activation count this run (thrash-guard signal). */
  openTimes(id: string): number { return this.openCount.get(id) ?? 0; }

  activate(id: string): { ok: boolean; error?: string; alreadyActive?: boolean } {
    const isMcp = this.dynamicMap.has(id);
    const isStatic = byId.has(id);
    if (!isMcp && !isStatic) {
      const all = [...ALL_SUBCONTEXTS, ...[...this.dynamicMap.keys()]].join(', ');
      return { ok: false, error: `Unknown sub-context "${id}". Available: ${all}.` };
    }
    if (this.active.has(id)) return { ok: true, alreadyActive: true };
    if (isMcp && this.mcpActiveCount >= this.maxActiveMcp) {
      return {
        ok: false,
        error: `MCP limit reached: ${this.mcpActiveCount} MCP servers active (${[...this.active].filter(a => this.dynamicMap.has(a)).join(', ')}). Deactivate one first.`,
      };
    }
    if (this.active.size >= this.maxActive) {
      return {
        ok: false,
        error: `Limit reached: ${this.maxActive} sub-contexts active (${this.activeIds.join(', ')}). Use action:"swap" with {deactivateIds, activateIds}, or action:"set" with the exact ids you want, to change the working set in one call.`,
      };
    }
    this.active.add(id);
    if (isMcp) this.mcpActiveCount++;
    this.openCount.set(id, (this.openCount.get(id) ?? 0) + 1);
    if (this.dynamicMap.has(id)) this.lastDelta = null;
    return { ok: true };
  }

  deactivate(id: string): { ok: boolean; error?: string; alreadyInactive?: boolean } {
    if (this.pinned.has(id)) {
      return { ok: false, error: `"${id}" is pinned (always-on operating guidance) — it cannot be deactivated.` };
    }
    if (!this.active.has(id)) {
      if (!byId.has(id) && !this.dynamicMap.has(id)) {
        const all = [...ALL_SUBCONTEXTS, ...[...this.dynamicMap.keys()]].join(', ');
        return { ok: false, error: `Unknown sub-context "${id}". Available ids: ${all}.` };
      }
      return { ok: true, alreadyInactive: true };
    }
    if (this.dynamicMap.has(id)) this.mcpActiveCount--;
    this.active.delete(id);
    if (this.dynamicMap.has(id)) this.lastDelta = null;
    return { ok: true };
  }

  /**
   * Declarative set: activate exactly `ids`, deactivating everything else.
   * Pinned ids are always kept. Replaces the need for manual swap bookkeeping.
   */
  setActive(ids: readonly string[]): { ok: boolean; error?: string; changed?: { opened: string[]; closed: string[] } } {
    const normalized = ids.map(String).filter((id) => id.length > 0);
    const unknown = normalized.filter((id) => !byId.has(id) && !this.dynamicMap.has(id));
    if (unknown.length > 0) {
      const all = [...ALL_SUBCONTEXTS, ...[...this.dynamicMap.keys()]].join(', ');
      return { ok: false, error: `Unknown sub-context(s): ${unknown.join(', ')}. Available ids: ${all}.` };
    }
    if (normalized.length > this.maxActive) {
      return {
        ok: false,
        error: `Limit reached: set requests ${normalized.length} contexts but max is ${this.maxActive}. Deactivate some first (request a smaller set, or use swap).`,
      };
    }
    const mcpCount = normalized.filter((id) => this.dynamicMap.has(id)).length;
    if (mcpCount > this.maxActiveMcp) {
      return {
        ok: false,
        error: `MCP limit reached: set requests ${mcpCount} MCP servers but max is ${this.maxActiveMcp}.`,
      };
    }

    const target = new Set<string>(normalized);
    for (const p of this.pinned) target.add(p);
    if (target.size > this.maxActive) {
      return { ok: false, error: `Limit reached: pinned + requested set exceeds ${this.maxActive}.` };
    }

    const opened: string[] = [];
    const closed: string[] = [];
    for (const id of target) {
      if (id && !this.active.has(id)) {
        if (this.dynamicMap.has(id)) this.mcpActiveCount++;
        this.active.add(id);
        this.openCount.set(id, (this.openCount.get(id) ?? 0) + 1);
        if (!this.dynamicMap.has(id)) opened.push(id);
      }
    }
    for (const id of [...this.active]) {
      if (!target.has(id)) {
        if (this.dynamicMap.has(id)) {
          this.mcpActiveCount--;
          continue;
        }
        this.active.delete(id);
        closed.push(id);
      }
    }
    this.lastDelta = opened.length > 0 || closed.length > 0
      ? { opened, closed }
      : null;
    return { ok: true, changed: { opened, closed } };
  }
}

export function renderSystemPromptCatalog(): string {
  const grouped = new Map<string, string[]>();
  for (const c of SUBCONTEXTS) {
    const group = c.category ?? 'other';
    const list = grouped.get(group);
    if (list) list.push(c.id); else grouped.set(group, [c.id]);
  }
  const lines: string[] = [];
  for (const [group, ids] of grouped) lines.push(`[${group}] ${ids.join(', ')}`);
  return lines.join('\n');
}

function costTag(c: SubContext): string {
  if (c.pinned) return ' [PINNED]';
  return c.cost ? ` [${c.cost}]` : '';
}

function panelLine(c: SubContext): string {
  const tag = costTag(c);
  const closeWhen = c.closeWhen ? ` (close when: ${c.closeWhen})` : '';
  return `- ${c.id} — ${c.title}. ${c.summary}${tag}${closeWhen}`;
}

function catalogLine(c: SubContext): string {
  const tag = costTag(c);
  return `- ${c.id} — ${c.summary}${tag}`;
}

function renderStockMcpActivation(manager: SubContextManager, configured: Map<string, boolean>): string {
  const stock = new Map(flattenStock().map((e) => [e.name.toLowerCase(), e]));
  const lines = STOCK_MCP_ACTIVATION_BY_CATEGORY.map((row) => {
    const servers = row.servers.map((s) => {
      const ent = stock.get(s.name.toLowerCase());
      const status = configured.has(s.name.toLowerCase())
        ? (configured.get(s.name.toLowerCase()) ? 'configured-active' : 'configured-disabled')
        : 'stock';
      const keyReq = ent
        ? ((ent.envKeys.length > 0 || ent.manualOAuth || ent.remote || ent.keyGetUrl) ? 'key-required' : 'keyless')
        : '?';
      const live = manager.isMcpContext(`mcp_${s.name.toLowerCase()}`) ? ' · mcp-active' : '';
      return `mcp_${s.name.toLowerCase()}[${status} | ${keyReq}${live}] — ${s.role}`;
    });
    return `- ${row.category}: ${servers.join(' | ')}`;
  });
  return [
    '',
    'STOCK MCP ACTIVATION — CATEGORY-WISE (which MCP to activate per domain; status = configured-active | configured-disabled | stock, key = key-required | keyless):',
    ...lines,
    'Activate at the phase gate with context_manage(action="activate") BEFORE using the domain\'s tools and FOLLOW THROUGH with the server. Configured-disabled / needs-key / not-added servers → request_mcp_approval first (configured-active + keyless can be activated directly).',
    '',
    'AGENT SKILLS (MANDATORY — activate on ANY work in the matching domain):',
    '- backend/API/DB/security work → mcp_agent-skills-backend → "Hosting & Backend" (--domain=backend, 18 skills) — api design, security hardening, spec, TDD.',
    '- frontend/UI/browser/perf work → mcp_agent-skills-frontend → "Frontend & UI" (--domain=frontend, 16 skills) — frontend-ui, browser-testing, a11y.',
    '- deploy/CI-CD/shipping/migration → mcp_agent-skills-devops → "Hosting & Backend" (--domain=devops, 8 skills) — ci-cd, shipping, migration, observability.',
    '- test/review/QA/debug work → mcp_agent-skills-qa → "Observability & Dev Tools" (--domain=qa, 5 skills) — TDD, code-review, debugging.',
    'ACTIVATE: context_manage(action="activate", contextId="mcp_agent-skills-<domain>") — pairs with its sub-context (e.g. mcp_agent-skills-backend + backend_scale). Full-stack work → activate the skill MCP for EVERY domain you enter.',
    'USE: after activation call <mcp-name>__list_skills() to see the catalog, <mcp-name>__recommend_skills({task:"…"}) to pick, then <mcp-name>__get_skill({skill:"…"}) and follow the SKILL.md verbatim (a GATE, not a suggestion). Pull checklists with <mcp-name>__get_reference({reference:"…"}).',
    'DEACTIVATE with its domain sub-context when the phase ends.',
  ].join('\n');
}

/** Top-N cap for the AVAILABLE listing — keeps the panel lean per turn. */
const AVAILABLE_SHORTLIST = 6;

export function renderContextPanel(manager: SubContextManager, task = '', configuredMcp: Map<string, boolean> = new Map()): string {
  const header: string[] = [];
  header.push('==================================================');
  header.push('SUB-CONTEXT PANEL');
  header.push('==================================================');
  header.push('Core rules live in the main system prompt. Load/unload sub-contexts with context_manage (activate / deactivate / swap). Keep active only what the current step needs.');
  header.push('MANDATORY RECONCILIATION THIS TURN — start from the ALREADY-OPEN set below (it persists from earlier in this session; it is your starting point, not a blank slate):');
  header.push('  (0) Read ACTIVE first — do NOT re-activate anything already ACTIVE.');
  header.push('  (1) Does the CURRENT step\'s domain have its matching sub-context(s) open? If not → context_manage(action="activate") them BEFORE any other tool call. Relevant sub-context opening is MANDATORY, not optional.');
  header.push('  (2) Does the CURRENT step touch a system (browser, DB, GitHub, deploy, …) with a matching ENABLED + fully-configured MCP server that is NOT ACTIVE? If yes → context_manage(action="activate") that mcp_<id> BEFORE acting (MCP-FIRST). Disabled / needs-setup / not-added servers are never auto-activated — they need request_mcp_approval first.');
  header.push('  (3) If nothing relevant is open at all for this domain → add it now: activate the best-matching sub-context (and MCP if applicable) so this phase runs with guidance loaded.');
  header.push('  (4) Deactivate ACTIVE items the current step no longer uses — they cost tokens on every call.');
  header.push('Active sub-contexts PERSIST after this run — deactivate is the only way to turn one off.');

  const active = manager.activeIds.map((id) => manager.resolve(id)).filter(Boolean) as SubContext[];
  const staticActive = active.filter((c) => byId.has(c.id));
  const mcpActive = active.filter((c) => manager.isMcpContext(c.id));

  if (staticActive.length === 0 && mcpActive.length === 0) {
    header.push(`ACTIVE SUB-CONTEXTS [0/${manager.maxActive}] — none loaded. If this step needs domain guidance, open it with context_manage.`);
  } else {
    header.push(`ACTIVE SUB-CONTEXTS [${staticActive.length + mcpActive.length}/${manager.maxActive}]:`);
    for (const c of staticActive) {
      const openTimes = manager.openTimes(c.id);
      const thrash = openTimes >= 3 ? ` [opened ${openTimes}x this run — settle on a set]` : '';
      header.push(panelLine(c) + thrash);
    }
    for (const c of mcpActive) header.push(`- ${c.id} — ${c.title}. ${c.summary}`);
    header.push('');
    header.push('ACTIVE SUB-CONTEXT CONTENT (follow this guidance):');
    for (const c of active) {
      header.push('');
      header.push(`──── ${c.id} (${c.title}) ────`);
      header.push(c.content);
    }
  }

  if (manager.lastDelta && (manager.lastDelta.opened.length > 0 || manager.lastDelta.closed.length > 0)) {
    header.push('');
    header.push(
      `LAST context_manage: opened [${manager.lastDelta.opened.join(', ') || '(none)'}], ` +
      `closed [${manager.lastDelta.closed.join(', ') || '(none)'}] ` +
      `(active ${manager.activeCount}/${manager.maxActive}).`,
    );
  }

  header.push('');
  const available = SUBCONTEXTS.filter((c) => !manager.isActive(c.id));
  const ranked = [...available].sort((a, b) => {
    if (task) {
      const d = relevanceScore(task, b) - relevanceScore(task, a);
      if (d !== 0) return d;
    }
    return a.id.localeCompare(b.id);
  });
  const shown = ranked.slice(0, AVAILABLE_SHORTLIST);
  const hiddenCount = ranked.length - shown.length;
  header.push(`AVAILABLE SUB-CONTEXTS [${ranked.length}] (inactive — activate on demand, ranked for this task):`);
  for (const c of shown) header.push(catalogLine(c));
  if (hiddenCount > 0) {
    header.push(`... and ${hiddenCount} more (full catalog in the base prompt; context_manage action:"list" shows the whole list).`);
  }

  const mcpIds = manager.registeredMcpIds;
  if (mcpIds.length > 0) {
    header.push('');
    header.push(`MCP SERVERS [${mcpActive.length}/${manager.maxActiveMcp} active] — activate with context_manage (max ${manager.maxActiveMcp} at once):`);
    for (const id of mcpIds) {
      const c = manager.resolve(id)!;
      const status = manager.isActive(id) ? 'ACTIVE' : 'available';
      header.push(`- ${id} — ${c.title} [${status}]`);
    }
  }

  header.push(renderStockMcpActivation(manager, configuredMcp));

  header.push('');
  return header.join('\n');
}