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

    // Only label function nodes to keep it readable
    node
      .filter((d) => d.kind === "function")
      .append("text")
      .attr("x", 6)
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 8)
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.label);

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
      .force("collide", d3.forceCollide(6))
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
