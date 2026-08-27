/**
 * Isolated mermaid rendering. Mermaid appends its own error diagnostics
 * ("Syntax error in text …") straight into document.body when render fails —
 * which leaked below the app. This module contains everything:
 *   1. parse() first with suppressErrors → syntax failures never reach render
 *      and never touch the DOM.
 *   2. render() targets a detached offscreen holder passed as the container,
 *      so even render-stage failures stay inside an element we remove.
 *   3. A body sweep removes any stray diagnostic nodes mermaid still created.
 */
let initialized = false;

async function getMermaid() {
  const { default: mermaid } = await import('mermaid');
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      logLevel: 'fatal',
      fontFamily: 'inherit',
      themeVariables: {
        darkMode: true,
        background: 'transparent',
        primaryColor: '#7C3AED',
        primaryTextColor: '#F8FAFC',
        primaryBorderColor: '#8B5CF6',
        lineColor: '#334155',
        secondaryColor: '#1a2333',
        tertiaryColor: '#111827',
        clusterBkg: '#111827',
        clusterBorder: '#334155',
        edgeLabelBackground: '#111827',
        nodeTextColor: '#F8FAFC',
      },
    });
    initialized = true;
  }
  return mermaid;
}

export async function renderMermaidSafely(rawId: string, code: string): Promise<string> {
  const mermaid = await getMermaid();

  // Stage 1: validate without DOM side effects. false = invalid syntax.
  const valid = await mermaid
    .parse(code, { suppressErrors: true })
    .catch(() => false);
  if (!valid) throw new Error('Invalid diagram syntax');

  // Stage 2: render inside our own offscreen container.
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;';
  document.body.appendChild(holder);
  try {
    const { svg } = await mermaid.render(`mmd-${rawId}`, code, holder);
    return svg;
  } finally {
    holder.remove();
    // Sweep stray diagnostics/temp nodes mermaid may have appended to <body>.
    document.body
      .querySelectorAll(':scope > [id^="dmmd"], :scope > [id^="mmd"]')
      .forEach((el) => el.remove());
  }
}
