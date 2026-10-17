import type { SearchEdge, SearchNode } from "./api";

export function routeTo(
  nodes: Record<string, SearchNode>,
  start: string,
  target: string,
): string[] {
  const reversed: string[] = [];
  const seen = new Set<string>();
  let word: string | null = target;
  while (word && nodes[word] && !seen.has(word)) {
    seen.add(word);
    reversed.push(word);
    if (word === start) return reversed.reverse();
    word = nodes[word].parent;
  }
  return [];
}

export function buildGraphView(
  nodes: Record<string, SearchNode>,
  edges: SearchEdge[],
  start: string,
  completedPath: string[],
  routeOnly: boolean,
) {
  const all = Object.values(nodes);
  const best = all
    .filter((node) => Number.isFinite(node.h))
    .sort(
      (a, b) =>
        a.h - b.h || a.discovered_sequence - b.discovered_sequence,
    )
    .find((node) => routeTo(nodes, start, node.word).length > 0);
  const completed =
    completedPath.length &&
    completedPath[0] === start &&
    completedPath.every((word) => nodes[word]);
  const route = completed
    ? completedPath
    : routeTo(nodes, start, best?.word || start);
  const routeSet = new Set(route);
  const chosen = new Set(route);
  if (!routeOnly) {
    const children = new Map<string, SearchNode[]>();
    for (const node of all) {
      if (!node.parent || !routeSet.has(node.parent) || routeSet.has(node.word))
        continue;
      const list = children.get(node.parent) || [];
      list.push(node);
      children.set(node.parent, list);
    }
    for (const word of route) {
      const nearby = (children.get(word) || []).sort(
        (a, b) => a.h - b.h || a.discovered_sequence - b.discovered_sequence,
      );
      for (const node of nearby.slice(0, 2)) chosen.add(node.word);
    }
  }
  const visible = [...chosen].map((word) => nodes[word]).filter(Boolean);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [index, word] of route.entries())
    positions.set(word, { x: 100 + index * 170, y: 190 });
  for (const [index, word] of route.entries()) {
    const branches = visible.filter((node) => node.parent === word && !routeSet.has(node.word));
    branches.forEach((node, branch) =>
      positions.set(node.word, {
        x: 160 + index * 170,
        y: branch === 0 ? 65 : 315,
      }),
    );
  }
  const wanted = new Set(
    visible
      .filter((node) => node.parent && chosen.has(node.parent))
      .map((node) => JSON.stringify([node.parent, node.word])),
  );
  const shownEdges = new Map<string, SearchEdge>();
  for (const edge of edges) {
    const pair = JSON.stringify([edge.source, edge.target]);
    if (wanted.has(pair)) shownEdges.set(pair, edge);
  }
  return { visible, route, positions, edges: shownEdges, completed: Boolean(completed) };
}
