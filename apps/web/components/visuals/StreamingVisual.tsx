'use client';

import { useEffect, useRef, useState } from 'react';
import { AddonShell } from './AddonShell';

/**
 * Live preview for an unfinished RDS-Visuals block (the tail of a still-
 * streaming message). Mirrors RDS's StreamingIframe: the base skeleton is
 * written into the iframe once, then each stream update patches the inner
 * container and a MutationObserver re-sizes the iframe to the content.
 */

const SKELETON = `<!DOCTYPE html>
<html>
  <head>
    <style>
      html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; height: auto !important; overflow-x: hidden !important; background: transparent !important; }
      * { box-sizing: border-box; }
    </style>
  </head>
  <body>
    <div id="stream-container"></div>
  </body>
</html>`;

function hasValidBody(html: string): boolean {
  return /<body|<div|<p|<span|<h[1-6]|<table|<style|<\/style|<script|<img|<button|<input|<ul|<ol|<li/.test(html);
}

export function StreamingVisual({ code }: { code: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    // Write the base skeleton once.
    if (!doc.body || doc.body.innerHTML.trim() === '') {
      doc.open();
      doc.write(SKELETON);
      doc.close();
    }

    const container = doc.getElementById('stream-container');
    if (container && container.innerHTML !== code) {
      container.innerHTML = code;
    }

    const resize = () => {
      const h = Math.max(
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
      );
      if (h > 0) setHeight(Math.max(80, h));
    };
    resize();

    const observer = new MutationObserver(resize);
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    doc.defaultView?.addEventListener('load', resize, true);
    window.addEventListener('resize', resize);

    return () => {
      observer.disconnect();
      doc.defaultView?.removeEventListener('load', resize, true);
      window.removeEventListener('resize', resize);
    };
  }, [code]);

  if (!hasValidBody(code)) {
    return (
      <AddonShell type="streaming" label="Building HTML preview…">
        <div className="h-14 animate-pulse bg-surface-800/60" />
      </AddonShell>
    );
  }

  return (
    <AddonShell type="visuals" label="Live preview">
      <div className="p-2">
        <iframe
          ref={iframeRef}
          title="streaming-preview"
          sandbox="allow-same-origin allow-scripts allow-modals allow-forms allow-popups allow-downloads allow-pointer-lock"
          className="block w-full border-0"
          style={{ height: `${height}px` }}
        />
      </div>
    </AddonShell>
  );
}
