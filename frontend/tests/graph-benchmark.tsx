// Development-only performance fixture. Not an entry point in the production build.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Graph } from "../src/Graph";
import type { SearchNode, SearchEdge } from "../src/api";
import "../src/styles.css";

const started = performance.now();
const noPath: string[] = [];
const nodes: Record<string, SearchNode> = Object.fromEntries(
  Array.from({ length: 5000 }, (_, i) => [
    `n${i}`,
    {
      word: `n${i}`,
      g: i * 0.15,
      h: 1 - i / 5000,
      f: i * 0.15 + 1 - i / 5000,
      depth: i,
      parent: i ? `n${i - 1}` : null,
      state: i % 2 ? "open" : "closed",
      discovered_sequence: i + 1,
      expanded_sequence: null,
    },
  ]),
);
const edges: SearchEdge[] = Array.from({ length: 4999 }, (_, i) => ({
  source: `n${i}`,
  target: `n${i + 1}`,
  cost: 0.15,
  cosine_similarity: 0.99,
  angular_distance: 0.045,
  selected: false,
}));
function Benchmark() {
  const [ready, setReady] = useState(false),
    [clicks, setClicks] = useState(0),
    [renderMs, setRenderMs] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        document
          .querySelector(".graph-wrap")
          ?.getAttribute("data-render-complete") !== "true"
      )
        return;
      setReady(true);
      setRenderMs(performance.now() - started);
      clearInterval(timer);
    }, 25);
    return () => clearInterval(timer);
  }, []);
  return (
    <div style={{ padding: 30, maxWidth: 1400, margin: "auto" }}>
      <h1>5,000-node rendering fixture</h1>
      <p>Original synthetic graph, not a language-model result.</p>
      <button className="button primary" onClick={() => setClicks(clicks + 1)}>
        応答確認 {clicks}
      </button>
      <output data-testid="render-ms">{renderMs}</output>
      <span role="status">{ready ? "ready" : "rendering"}</span>
      <Graph
        nodes={nodes}
        edges={edges}
        path={noPath}
        current="n2500"
        start="n0"
        goal="n4999"
        focus={false}
        labels={false}
        size="fixed"
        select={() => {}}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Benchmark />);
