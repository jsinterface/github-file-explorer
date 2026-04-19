import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";
import type { SymbolGraph as SymbolGraphData } from "@/lib/symbolGraph";

type Placed = {
  id: string;
  label: string;
  file: string;
  name: string;
  kind: "function" | "value";
  a0: number;
  a1: number;
  angle: number; // midpoint
  indegree: number;
};

type Ribbon = { source: Placed; target: Placed };

export function SymbolLoomView({ data }: { data: SymbolGraphData }) {
  const ref = useRef<SVGSVGElement | null>(null);

  const built = useMemo(() => {
    // Indegree + degree
    const indegree = new Map<string, number>();
    const degree = new Map<string, number>();
    for (const l of data.links) {
      const sId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const tId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      indegree.set(tId, (indegree.get(tId) ?? 0) + 1);
      degree.set(sId, (degree.get(sId) ?? 0) + 1);
      degree.set(tId, (degree.get(tId) ?? 0) + 1);
    }
    // Filter unconnected
    const kept = data.nodes.filter((n) => (degree.get(n.id) ?? 0) > 0);

    // Group by file, sort files by node count desc, then nodes within file by name
    const byFile = new Map<string, typeof kept>();
    for (const n of kept) {
      if (!byFile.has(n.file)) byFile.set(n.file, []);
      byFile.get(n.file)!.push(n);
    }
    const files = Array.from(byFile.keys()).sort(
      (a, b) => (byFile.get(b)!.length - byFile.get(a)!.length) || a.localeCompare(b),
    );
    for (const f of files) {
      byFile.get(f)!.sort((a, b) => a.name.localeCompare(b.name));
    }

    const ordered: typeof kept = [];
    const fileSpans: Array<{ file: string; start: number; end: number }> = [];
    for (const f of files) {
      const start = ordered.length;
      ordered.push(...byFile.get(f)!);
      fileSpans.push({ file: f, start, end: ordered.length - 1 });
    }

    return { ordered, fileSpans, indegree };
  }, [data]);

  useEffect(() => {
    if (!ref.current) return;

    const { ordered, fileSpans, indegree } = built;
    const N = ordered.length;
    if (N === 0) return;

    const size = 960;
    const cx = size / 2;
    const cy = size / 2;
    // Node arc band sits as part of the outer ring.
    const nodeOuterR = size / 2 - 80;
    const nodeInnerR = nodeOuterR - 14;
    // File-group band sits just outside the node band.
    const fileInnerR = nodeOuterR + 4;
    const fileOuterR = fileInnerR + 6;
    const fileLabelR = fileOuterR + 6;

    // Each node gets an arc length proportional to its indegree.
    // We give every node a small minimum arc so zero-indegree connected
    // nodes (those that only reference others) remain visible.
    const indegArr = ordered.map((n) => indegree.get(n.id) ?? 0);
    const totalIndeg = indegArr.reduce((a, b) => a + b, 0);
    const MIN_FRAC = 0.25; // each node gets at least this fraction of an "average slice"

    const gapPerGroup = 0.012; // radians between file groups
    const totalGroupGap = gapPerGroup * fileSpans.length;
    const usable = Math.PI * 2 - totalGroupGap;

    // Compute a weight per node: max(indeg, MIN_FRAC * avg)
    const avgIndeg = totalIndeg / Math.max(1, N);
    const weights = indegArr.map((d) => Math.max(d, MIN_FRAC * Math.max(avgIndeg, 1)));
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

    const placed: Placed[] = [];
    const fileArcs: Array<{ file: string; a0: number; a1: number; color: string }> = [];

    let cursor = -Math.PI / 2; // start at top
    const colors = d3.schemeTableau10;
    fileSpans.forEach((span, fi) => {
      const a0 = cursor;
      for (let idx = span.start; idx <= span.end; idx++) {
        const n = ordered[idx];
        const arc = (weights[idx] / totalWeight) * usable;
        const na0 = cursor;
        const na1 = cursor + arc;
        const angle = (na0 + na1) / 2;
        placed.push({
          id: n.id,
          label: n.label,
          file: n.file,
          name: n.name,
          kind: n.kind,
          a0: na0,
          a1: na1,
          angle,
          indegree: indegree.get(n.id) ?? 0,
        });
        cursor = na1;
      }
      const a1 = cursor;
      fileArcs.push({ file: span.file, a0, a1, color: colors[fi % colors.length] });
      cursor += gapPerGroup;
    });

    const idToPlaced = new Map(placed.map((p) => [p.id, p]));

    const ribbons: Ribbon[] = [];
    for (const l of data.links) {
      const sId = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const tId = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      const s = idToPlaced.get(sId);
      const t = idToPlaced.get(tId);
      if (s && t && s !== t) ribbons.push({ source: s, target: t });
    }

    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    svg
      .attr("viewBox", `0 0 ${size} ${size}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const container = svg.append("g");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 8])
      .on("zoom", (event) => container.attr("transform", event.transform.toString()));
    svg.call(zoomBehavior);

    // ---- File group arcs (outer band) ----
    const arcGen = d3
      .arc<{ a0: number; a1: number }>()
      .innerRadius(fileInnerR)
      .outerRadius(fileOuterR)
      .startAngle((d) => d.a0 + Math.PI / 2)
      .endAngle((d) => d.a1 + Math.PI / 2);

    container
      .append("g")
      .attr("transform", `translate(${cx}, ${cy})`)
      .selectAll("path")
      .data(fileArcs)
      .join("path")
      .attr("d", (d) => arcGen({ a0: d.a0, a1: d.a1 })!)
      .attr("fill", (d) => d.color)
      .attr("opacity", 0.85)
      .append("title")
      .text((d) => d.file);

    // ---- File labels (curved-ish, placed at midpoint) ----
    container
      .append("g")
      .selectAll("text")
      .data(fileArcs)
      .join("text")
      .attr("transform", (d) => {
        const a = (d.a0 + d.a1) / 2;
        const x = cx + fileLabelR * Math.cos(a);
        const y = cy + fileLabelR * Math.sin(a);
        const deg = (a * 180) / Math.PI;
        // Flip text on the left half so it stays upright-ish
        const flip = a > Math.PI / 2 && a < (3 * Math.PI) / 2;
        const rot = flip ? deg + 180 : deg;
        return `translate(${x},${y}) rotate(${rot})`;
      })
      .attr("text-anchor", (d) => {
        const a = (d.a0 + d.a1) / 2;
        const flip = a > Math.PI / 2 && a < (3 * Math.PI) / 2;
        return flip ? "end" : "start";
      })
      .attr("dy", "0.32em")
      .attr("dx", (d) => {
        const a = (d.a0 + d.a1) / 2;
        const flip = a > Math.PI / 2 && a < (3 * Math.PI) / 2;
        return flip ? -6 : 6;
      })
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 9)
      .attr("fill", "var(--color-foreground)")
      .text((d) => {
        const parts = d.file.split("/");
        return parts.slice(-2).join("/");
      });

    // ---- Ribbons (bezier through center, attaching at inner edge of node band) ----
    function ribbonPath(r: Ribbon): string {
      const sx = cx + nodeInnerR * Math.cos(r.source.angle);
      const sy = cy + nodeInnerR * Math.sin(r.source.angle);
      const tx = cx + nodeInnerR * Math.cos(r.target.angle);
      const ty = cy + nodeInnerR * Math.sin(r.target.angle);
      return `M${sx},${sy} C${cx},${cy} ${cx},${cy} ${tx},${ty}`;
    }

    container
      .append("g")
      .attr("fill", "none")
      .attr("stroke", "var(--color-chart-3)")
      .attr("stroke-opacity", 0.25)
      .attr("stroke-width", 0.7)
      .selectAll("path")
      .data(ribbons)
      .join("path")
      .attr("d", ribbonPath)
      .append("title")
      .text((r) => `${r.source.label} → ${r.target.label}`);

    // ---- Node arcs as part of the surrounding ring (scaled by indegree) ----
    const nodeArcGen = d3
      .arc<Placed>()
      .innerRadius(nodeInnerR)
      .outerRadius(nodeOuterR)
      .startAngle((d) => d.a0 + Math.PI / 2)
      .endAngle((d) => d.a1 + Math.PI / 2)
      .padAngle(0.0015);

    const nodeG = container
      .append("g")
      .attr("transform", `translate(${cx}, ${cy})`)
      .selectAll("g")
      .data(placed)
      .join("g");

    nodeG
      .append("path")
      .attr("d", (d) => nodeArcGen(d)!)
      .attr("fill", (d) =>
        d.kind === "function" ? "var(--color-chart-1)" : "var(--color-chart-2)",
      )
      .attr("stroke", "var(--color-background)")
      .attr("stroke-width", 0.4);

    nodeG.append("title").text((d) => `${d.label} · in:${d.indegree}`);

    // ---- Node labels along the radial direction (only when arc is wide enough) ----
    const MIN_LABEL_ARC = 0.012; // radians
    nodeG
      .filter((d) => d.a1 - d.a0 >= MIN_LABEL_ARC)
      .append("text")
      .attr("transform", (d) => {
        const deg = (d.angle * 180) / Math.PI;
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        // Position at outer edge of arc band
        const r = nodeOuterR + 2;
        const x = r * Math.cos(d.angle);
        const y = r * Math.sin(d.angle);
        return flip
          ? `translate(${x},${y}) rotate(${deg + 180})`
          : `translate(${x},${y}) rotate(${deg})`;
      })
      .attr("text-anchor", (d) => {
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? "end" : "start";
      })
      .attr("dx", (d) => {
        const flip = d.angle > Math.PI / 2 && d.angle < (3 * Math.PI) / 2;
        return flip ? -3 : 3;
      })
      .attr("dy", "0.32em")
      .attr("font-family", "ui-monospace, monospace")
      .attr("font-size", 7)
      .attr("fill", "var(--color-foreground)")
      .text((d) => d.name);

    return () => {
      svg.on(".zoom", null);
      svg.selectAll("*").remove();
    };
  }, [built]);

  return (
    <div className="rounded-md border border-border bg-muted">
      <div className="max-h-[80vh] overflow-hidden">
        <svg ref={ref} className="w-full" style={{ height: "75vh" }} />
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
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-0.5"
            style={{ background: "var(--color-chart-3)" }}
          />
          reference
        </span>
        <span>nodes grouped by file · scaled by indegree</span>
        <span className="ml-auto">scroll to zoom</span>
      </div>
    </div>
  );
}
