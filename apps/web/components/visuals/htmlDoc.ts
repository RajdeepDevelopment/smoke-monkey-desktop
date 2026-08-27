/**
 * Shared helpers for turning raw HTML (a visual / project entry file) into a
 * sandboxed iframe `srcDoc` that auto-resizes to its rendered content.
 *
 * The resize bridge is injected into the document before `</body>`/`</html>`
 * and posts { type: 'rag:resize', height } to the parent window so the wrapper
 * can grow the iframe once the visual settles.
 */

export const HTML_RE = /<html[\s\S]*<\/html>/i;

export const RESIZE_BRIDGE =
  '<script>(function(){function r(){var h=Math.max(document.body&&document.body.scrollHeight||0,document.documentElement.scrollHeight);parent.postMessage({type:"rag:resize",height:h},"*");}window.addEventListener("load",function(){setTimeout(r,60)});window.addEventListener("resize",r);if(document.readyState!=="loading")setTimeout(r,60);})();<\/script>';

/** Sanitize a raw block and produce a full HTML document for srcDoc. */
export function buildSrcDoc(raw: string): string {
  const cleaned = raw
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\[object Object\]/g, '')
    .trim();
  const full = HTML_RE.exec(cleaned);
  let doc = full ? full[0] : cleaned;
  if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, RESIZE_BRIDGE + '</body>');
  else if (/<\/html>/i.test(doc)) doc = doc.replace(/<\/html>/i, RESIZE_BRIDGE + '</html>');
  else doc = doc + RESIZE_BRIDGE;
  return doc;
}
