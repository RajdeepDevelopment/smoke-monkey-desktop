/**
 * Lightweight Git-agent system prompts.
 *
 * These are intentionally SMALL — a commit-message / change-review job is a
 * single, focused LLM call, so it gets a short instruction layer instead of the
 * full agent system prompt. Keeps token usage + latency low and behavior
 * predictable.
 *
 * The prompt enforces the source-control ground rules: never invent changes,
 * base every claim on the real diff, and never let the user's requested wording
 * override reality.
 */

export type GitAgentKind = 'commit-message' | 'review';

const GIT_GROUND_RULES = [
  'Inspect the actual Git state before making claims.',
  'Base everything on the real git status and diff you are given — never invent files, changes, commits, branches, or repository state.',
  'When the user provides wording instructions, follow them only when they are consistent with the actual diff.',
  'If the user\'s requested message contradicts the diff, say so plainly and stick to the real changes.',
  'Keep commit messages concise, conventional, and concrete.',
  'Use the conventional commit format when appropriate: type(scope): subject.',
  'Separate the commit subject from the detailed body.',
  'Never claim an operation succeeded, and never recommend destructive Git actions.',
  'Output clean, lightweight markdown — headings, short bullet points, and tables only when they genuinely help.',
];

const COMMIT_FORMAT_RULES = [
  'First line is the subject in conventional-commit form (e.g. fix(auth): handle JWT expiry).',
  'The body is a short, pointed bullet list describing what changed and why.',
  'Group related bullets; do not repeat the subject.',
  'Do not list every changed line — summarize the intent.',
  'Match the repository\'s existing commit style when it is visible in the sample log.',
];

const REVIEW_FORMAT_RULES = [
  'Start with a one-line status: "Ready to commit" or "Review before commit".',
  'Use a short "Summary" paragraph, then "Potential issues" as bullets.',
  'Use a compact files table with columns | File | Change |.',
  'Include a suggested commit message at the end.',
  'Keep it short — do not pad.',
];

const SYSTEM_TEMPLATE = `You are helping with Git source-control operations in Smoke Monkey.

GRID LINES
1. ${GIT_GROUND_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}

JOB
You are generating a {KIND}.

OUTPUT FORMAT ({KIND})
- {FORMAT_RULES}

The user instruction (when present) is guidance for wording — never allowed to override what the actual diff shows.
`;

/** Build the lightweight Git-agent system prompt for a given job kind. */
export function buildGitSystemPrompt(kind: GitAgentKind): string {
  const rules = kind === 'commit-message' ? COMMIT_FORMAT_RULES : REVIEW_FORMAT_RULES;
  return SYSTEM_TEMPLATE
    .replace('{KIND}', kind === 'commit-message' ? 'commit message' : 'change review')
    .replace('{FORMAT_RULES}', rules.map((r) => `- ${r}`).join('\n'));
}