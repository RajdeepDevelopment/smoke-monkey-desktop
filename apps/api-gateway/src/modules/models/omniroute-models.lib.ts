/**
 * OmniRoute model metadata helpers — namespace, family, free-tier and protocol
 * (chat vs image/video) classification. Shared by the model-health ranker and
 * the models controller so free/availability/speed flags stay consistent.
 */

export type OmniRouteProtocol = 'chat' | 'image' | 'video';

/** Namespace = the leading `provider/` segment, or the bare gateway lane. */
export function omnirouteNamespace(id: string): string {
  const slash = id.indexOf('/');
  if (slash <= 0) return 'omniroute';
  return id
    .slice(0, slash)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

/** Best-effort family keyword derived from the model id (claude, gpt, …). */
const FAMILY_RE =
  /\b(?:claude|gpt|gemini|qwen|llama|glm|kimi|deepseek|mistral|grok|nemotron|big-pickle|mimo|muse|north|hy3|inkling|swe)\b/i;

export function omnirouteModelFamily(id: string): string {
  const m = id.match(FAMILY_RE);
  return m ? m[0].toLowerCase() : 'other';
}

/**
 * Protocol classification: whether the model is a chat model or an image/video
 * generator (aihorde SD checkpoints, veo/seedance). Image/video models are the
 * only ones probed against the images endpoint.
 */
export function omnirouteProtocol(id: string): OmniRouteProtocol {
  const lower = id.toLowerCase();
  if (lower.includes('aihorde')) return 'image';
  if (
    /(^|[\/._:-])veo($|[\/._:-])/.test(lower) ||
    lower.includes('seedance') ||
    lower.includes('veoaifree')
  ) {
    return 'video';
  }
  return 'chat';
}

/**
 * OmniRoute marks a model free when "free" appears as a distinct token in its
 * id (e.g. auto/coding:free, auto/best-free, oc/mimo-v2.5-free). Namespaces
 * alone (oc, auto, …) are NOT a free signal — oc/big-pickle, auto/pro-*, etc.
 * are paid, so we must not flag every id that merely lives in a known lane.
 */
export function isOmniRouteFreeModel(id: string): boolean {
  const lower = id.toLowerCase();
  return /(^|[/:._-])free([/._:-]|$)/.test(lower) || lower.endsWith(':free');
}