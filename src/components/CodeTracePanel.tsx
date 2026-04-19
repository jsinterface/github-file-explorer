import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionTrace } from "@/lib/runFunction";

type Props = {
  trace: FunctionTrace;
  filePath: string;
  step: number; // current call-site index (-1 = none)
  result?: { ok: true; value: unknown } | { ok: false; error: string } | null;
  onClose: () => void;
};

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function CodeTracePanel({ trace, filePath, step, result, onClose }: Props) {
  const codeRef = useRef<HTMLPreElement | null>(null);

  const html = useMemo(() => {
    const { source, bodyStart, bodyEnd, callSites } = trace;
    // Render the function body only (with a few lines of context above)
    const contextStart = Math.max(0, source.lastIndexOf("\n", Math.max(0, bodyStart - 200)));
    const start = contextStart;
    const end = bodyEnd;
    const slice = source.slice(start, end);
    let out = "";
    let cursor = 0;
    callSites.forEach((cs, i) => {
      const localStart = cs.start - start;
      const localEnd = cs.end - start;
      if (localStart < cursor) return;
      out += escapeHtml(slice.slice(cursor, localStart));
      out += `<span class="ref-token" data-step="${i}">${escapeHtml(slice.slice(localStart, localEnd))}</span>`;
      cursor = localEnd;
    });
    out += escapeHtml(slice.slice(cursor));
    return out;
  }, [trace]);

  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;
    const tokens = el.querySelectorAll<HTMLSpanElement>(".ref-token");
    tokens.forEach((t) => {
      const idx = Number(t.dataset.step);
      t.classList.toggle("ref-active", idx === step);
      t.classList.toggle("ref-visited", idx >= 0 && idx < step);
    });
    if (step >= 0) {
      const active = el.querySelector<HTMLSpanElement>(`.ref-token[data-step="${step}"]`);
      active?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [step, html]);

  const [resultOpen, setResultOpen] = useState(true);

  return (
    <div className="pointer-events-auto absolute inset-0 z-0 flex flex-col rounded-md bg-background/30 backdrop-blur-sm">

      <style>{`
        .ref-token { background: color-mix(in oklab, var(--color-accent) 30%, transparent); border-radius: 2px; padding: 0 1px; transition: all 0.25s; }
        .ref-visited { background: color-mix(in oklab, #536dfe 25%, transparent); }
        .ref-active { background: #ffff00; color: #000; box-shadow: 0 0 0 2px #536dfe; }
      `}</style>
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
        <div className="truncate font-mono">
          <span className="text-muted-foreground">{filePath}</span>
          <span className="px-1 text-muted-foreground">·</span>
          <span className="font-semibold">{trace.exportName}()</span>
          <span className="px-1 text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            step {Math.max(0, step + 1)}/{trace.callSites.length}
          </span>
        </div>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <pre
        ref={codeRef}
        className="flex-1 overflow-auto bg-transparent p-3 font-mono text-xs leading-relaxed text-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {result && (
        <div className="border-t border-border/40">
          <button
            className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
            onClick={() => setResultOpen((v) => !v)}
          >
            <span>
              {result.ok ? "✓ Result" : "✗ Error"}
            </span>
            <span>{resultOpen ? "▾" : "▸"}</span>
          </button>
          {resultOpen && (
            <pre className="max-h-40 overflow-auto bg-transparent px-3 pb-3 font-mono text-xs">
              {result.ok
                ? safeStringify(result.value)
                : result.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
