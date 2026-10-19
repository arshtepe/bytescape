import { useEffect, useMemo, useState, type RefObject } from "react";
import type { ScanNode } from "../../shared/types";
import { formatBytes, paletteColor } from "../format";

interface LayoutItem {
  node: ScanNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

function buildTreemap(nodes: ScanNode[], x: number, y: number, width: number, height: number, output: LayoutItem[] = []): LayoutItem[] {
  const visible = nodes.filter((node) => node.size > 0);
  if (!visible.length || width < 2 || height < 2) return output;
  if (visible.length === 1) {
    output.push({ node: visible[0] as ScanNode, x, y, width, height });
    return output;
  }

  const total = visible.reduce((sum, node) => sum + node.size, 0);
  let running = 0;
  let split = 1;
  for (let index = 0; index < visible.length; index += 1) {
    if (running + (visible[index] as ScanNode).size > total / 2 && index > 0) break;
    running += (visible[index] as ScanNode).size;
    split = index + 1;
  }
  split = Math.max(1, Math.min(visible.length - 1, split));
  const left = visible.slice(0, split);
  const right = visible.slice(split);
  const leftSize = left.reduce((sum, node) => sum + node.size, 0);
  const ratio = leftSize / total;

  if (width >= height) {
    const leftWidth = Math.max(1, Math.round(width * ratio));
    buildTreemap(left, x, y, leftWidth, height, output);
    buildTreemap(right, x + leftWidth, y, width - leftWidth, height, output);
  } else {
    const topHeight = Math.max(1, Math.round(height * ratio));
    buildTreemap(left, x, y, width, topHeight, output);
    buildTreemap(right, x, y + topHeight, width, height - topHeight, output);
  }
  return output;
}

interface TreemapProps {
  nodes: ScanNode[];
  refEl: RefObject<HTMLDivElement | null>;
  onSelect: (node: ScanNode) => void;
  emptyText: string;
}

export function Treemap({ nodes, refEl, onSelect, emptyText }: TreemapProps) {
  const [size, setSize] = useState({ width: 1, height: 1 });

  useEffect(() => {
    if (!refEl.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(refEl.current);
    return () => observer.disconnect();
  }, [refEl]);

  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const layout = useMemo(() => buildTreemap(nodes, 0, 0, width, height), [nodes, width, height]);

  return (
    <div className="treemap" ref={refEl}>
      {!nodes.length ? (
        <div className="treemap-empty">{emptyText}</div>
      ) : !layout.length ? (
        <div className="treemap-empty">No sizable child items</div>
      ) : (
        <div className="treemap-canvas" style={{ width, height }}>
          {layout.map((item, index) => {
            const show = item.width > 66 && item.height > 40;
            const minDim = Math.min(item.width, item.height);
            const fontSize = Math.max(11, Math.min(23, minDim / 5.4));
            return (
              <button
                key={item.node.path}
                type="button"
                className="treemap-tile"
                title={`${item.node.name} · ${formatBytes(item.node.size)}${item.node.kind === "directory" ? " — click to open" : ""}`}
                onClick={() => onSelect(item.node)}
                style={{
                  position: "absolute",
                  left: item.x,
                  top: item.y,
                  width: Math.max(0, item.width),
                  height: Math.max(0, item.height),
                  background: paletteColor(index),
                  cursor: item.node.kind === "directory" ? "pointer" : "default"
                }}
              >
                {show ? (
                  <>
                    <div style={{ fontSize, fontWeight: 700, lineHeight: 1.15, maxWidth: "92%", textAlign: "center" }}>{item.node.name}</div>
                    {minDim > 58 ? (
                      <div style={{ fontSize: Math.max(10, Math.round(fontSize * 0.72)), fontWeight: 500, opacity: 0.82, marginTop: 3 }}>
                        {formatBytes(item.node.size)}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
