import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { SymbolGraph as SymbolGraphData } from "@/lib/symbolGraph";

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  label: string;
  kind: "function" | "value";
};

type SimLink = d3.SimulationLinkDatum<SimNode>;

export function SymbolGraphView({ data }: { data: SymbolGraphData }) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const width = 960;
    const height = 640;

    // Compute degree, then drop unconnected nodes
    const degree = new Map<string, number>();
    const indegree = new Map<string, number>();
    for (const l of data.links) {
      const sId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const tId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      degree.set(sId, (degree.get(sId) ?? 0) + 1);
      degree.set(tId, (degree.get(tId) ?? 0) + 1);
      indegree.set(tId, (indegree.get(tId) ?? 0) + 1);
    }
    const keep = new Set(
      data.nodes.filter((n) => (degree.get(n.id) ?? 0) > 0).map((n) => n.id),
    );

    const nodes: SimNode[] = data.nodes
      .filter((n) => keep.has(n.id))
      .map((n) => ({ ...n }));
    const links: SimLink[] = data.links
      .filter((l) => {
        const sId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
        const tId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
        return keep.has(sId) && keep.has(tId);
      })
      .map((l) => ({ ...l }));

    const maxIn = Math.max(1, ...Array.from(indegree.values()));
    const radiusFor = (id: string, kind: SimNode["kind"]) => {
      const inDeg = indegree.get(id) ?? 0;
      const base = kind === "function" ? 4 : 2.5;
      // Scale by sqrt of indegree, normalized
      return base + 10 * Math.sqrt(inDeg / maxIn);
    };

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg.append("g");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 8])
      .on("zoom", (event) => container.attr("transform", event.transform.toString()));
    svg.call(zoomBehavior);

    svg
      .append("defs")
      .append("marker")
      .attr("id", "arrow-sym")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 12)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "var(--color-border)");

    const link = container
      .append("g")
      .attr("stroke", "var(--color-border)")
      .attr("stroke-opacity", 0.5)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 0.8)
      .attr("marker-end", "url(#arrow-sym)");

    const node = container
      .append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(nodes)
      .join("g")
      .style("cursor", "grab");

    node
      .append("circle")
      .attr("r", (d) => radiusFor(d.id, d.kind))
      .attr("fill", (d) =>
        d.kind === "function" ? "var(--color-chart-1)" : "var(--color-chart-2)",
      )
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 0.8);

    node.append("title").text((d) => `${d.label} · in:${indegree.get(d.id) ?? 0}`);

    // Pick a font size and line wrapping such that the ENTIRE label fits
    // inside the circle's inscribed square — no truncation, no ellipsis.
    const CHAR_W = 0.6; // monospace char width factor relative to font-size
    const LINE_H = 1.1;

    // Wrap text into at most `maxLines` lines, each at most `maxChars` chars.
    // Returns null if it cannot fit (a single token longer than maxChars and
    // we're not allowed to hard-break — we always allow hard-break here, so
    // it returns lines unless maxChars < 1).
    function wrapText(text: string, maxChars: number, maxLines: number): string[] | null {
      if (maxChars < 1) return null;
      const tokens = text.split(/([\/:_\-.])/).filter(Boolean);
      const lines: string[] = [];
      let current = "";
      const flush = () => {
        if (current) {
          lines.push(current);
          current = "";
        }
      };
      for (const tok of tokens) {
        let rest = tok;
        // If token alone is too long, hard-break it across lines.
        while (rest.length > maxChars) {
          if (current.length + rest.length > maxChars) flush();
          const take = maxChars - current.length;
          if (take > 0) {
            current += rest.slice(0, take);
            rest = rest.slice(take);
          }
          flush();
          if (lines.length >= maxLines) return null;
        }
        if ((current + rest).length <= maxChars) {
          current += rest;
        } else {
          flush();
          if (lines.length >= maxLines) return null;
          current = rest;
        }
      }
      flush();
      if (lines.length > maxLines) return null;
      return lines;
    }

    function fitLabel(text: string, radius: number): { lines: string[]; fontSize: number } {
      const usableSide = radius * 1.4; // inscribed square with padding
      // Try font sizes from large to small and pick the largest that fits.
      for (let fs = 14; fs >= 2; fs -= 0.5) {
        const maxChars = Math.max(1, Math.floor(usableSide / (fs * CHAR_W)));
        const maxLines = Math.max(1, Math.floor(usableSide / (fs * LINE_H)));
        const lines = wrapText(text, maxChars, maxLines);
        if (lines) return { lines, fontSize: fs };
      }
      // Fallback: render at minimum size on a single line (very small radii).
      return { lines: [text], fontSize: 2 };
    }

    const labelGroup = node.append("g").attr("text-anchor", "middle");
    labelGroup.each(function (d) {
      const r = radiusFor(d.id, d.kind);
      const { lines, fontSize } = fitLabel(d.label, r);
      const totalH = (lines.length - 1) * fontSize * LINE_H;
      const startY = -totalH / 2;
      const sel = d3.select(this);
      lines.forEach((ln, i) => {
        sel
          .append("text")
          .attr("x", 0)
          .attr("y", startY + i * fontSize * LINE_H)
          .attr("dy", "0.32em")
          .attr("font-family", "ui-monospace, monospace")
          .attr("font-size", fontSize)
          .attr("fill", "var(--color-background)")
          .attr("pointer-events", "none")
          .text(ln);
      });
    });

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(30)
          .strength(0.25),
      )
      .force("charge", d3.forceManyBody().strength(-40))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<SimNode>((d) => radiusFor(d.id, d.kind) + 1))
      .on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x!)
          .attr("y1", (d) => (d.source as SimNode).y!)
          .attr("x2", (d) => (d.target as SimNode).x!)
          .attr("y2", (d) => (d.target as SimNode).y!);
        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag);

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [data]);

  return (
    <div className="rounded-md border border-border bg-muted">
      <div className="max-h-[70vh] overflow-hidden">
        <svg ref={ref} className="w-full" style={{ height: "70vh" }} />
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--color-chart-1)" }}
          />
          function export
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "var(--color-chart-2)" }}
          />
          value export
        </span>
        <span>
          {data.nodes.length} symbols · {data.links.length} refs · {data.functionCount}{" "}
          functions
        </span>
        <span className="ml-auto">drag nodes • scroll to zoom</span>
      </div>
    </div>
  );
}
