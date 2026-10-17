import { create } from "zustand";
import type { Experiment, LabEvent, SearchEdge, SearchNode } from "./api";

type Workspace = {
  modelId: string;
  modelSelectionMade: boolean;
  experiment: Experiment | null;
  selectedWord: string;
  projectionWords: string[];
  projectionVectors: { label: string; vector: number[] }[];
  projectionRoles: Record<string, string>;
  jobId: string | null;
  selectedNode: SearchNode | null;
  selectedSearchId: string | null;
  inspectNode: (node: SearchNode, searchId?: string) => void;
  setModel: (id: string) => void;
  setExperiment: (e: Experiment | null) => void;
  select: (word: string) => void;
  project: (
    words: string[],
    vectors?: { label: string; vector: number[] }[],
    roles?: Record<string, string>,
  ) => void;
  setJob: (id: string) => void;
};
export const useWorkspace = create<Workspace>((set) => ({
  modelId: "tiny-ja",
  modelSelectionMade: false,
  experiment: null,
  selectedWord: "猫",
  projectionWords: [],
  projectionVectors: [],
  projectionRoles: {},
  jobId: null,
  selectedNode: null,
  selectedSearchId: null,
  setModel: (modelId) =>
    set({
      modelId,
      modelSelectionMade: true,
      experiment: null,
      selectedWord: "",
      jobId: null,
      projectionWords: [],
      projectionVectors: [],
      projectionRoles: {},
      selectedNode: null,
      selectedSearchId: null,
    }),
  setExperiment: (experiment) => set({ experiment }),
  select: (selectedWord) =>
    set({ selectedWord, selectedNode: null, selectedSearchId: null }),
  inspectNode: (selectedNode, selectedSearchId) =>
    set({
      selectedNode,
      selectedWord: selectedNode.word,
      selectedSearchId: selectedSearchId ?? null,
    }),
  project: (projectionWords, projectionVectors = [], projectionRoles = {}) =>
    set({ projectionWords, projectionVectors, projectionRoles }),
  setJob: (jobId) => set({ jobId }),
}));
export function mergeEvents(
  previous: LabEvent[],
  incoming: LabEvent[],
): LabEvent[] {
  if (!incoming.length) return previous;
  const lastSequence = previous.at(-1)?.sequence ?? 0;
  if (
    incoming[0].sequence > lastSequence &&
    incoming.every((event, index) =>
      index === 0 ? true : event.sequence > incoming[index - 1].sequence,
    )
  )
    return previous.concat(incoming);
  const known = new Set(previous.map((e) => e.sequence));
  if (incoming.every((e) => known.has(e.sequence))) return previous;
  const events = new Map(previous.map((e) => [e.sequence, e]));
  incoming.forEach((e) => {
    if (!events.has(e.sequence)) events.set(e.sequence, e);
  });
  return [...events.values()].sort((a, b) => a.sequence - b.sequence);
}
export type ReplaySnapshot = {
  nodes: Record<string, SearchNode>;
  edges: SearchEdge[];
  path: string[];
  current: string;
  iteration: number;
  k: number;
  last?: LabEvent;
};
export function advanceReplay(
  previous: ReplaySnapshot,
  events: LabEvent[],
): ReplaySnapshot {
  let nodes = { ...previous.nodes },
    edges = previous.edges.slice(),
    path = previous.path;
  let { current, iteration, k, last } = previous;
  for (const e of events) {
    last = e;
    if (e.type === "iteration_started") {
      nodes = {};
      edges = [];
      path = [];
      current = "";
      iteration = e.iteration;
      k = e.k;
    }
    if (["node_discovered", "node_updated", "node_expanded"].includes(e.type)) {
      nodes[e.word] = e as unknown as SearchNode;
      if (e.edge) edges.push(e.edge);
      if (e.type === "node_expanded") current = e.word;
    }
    if (e.type === "edge_observed") edges.push(e as unknown as SearchEdge);
    if (e.type === "goal_found" || e.type === "search_completed")
      path = e.path || [];
  }
  return { nodes, edges, path, current, iteration, k, last };
}
export function replay(events: LabEvent[], cursor = Infinity): ReplaySnapshot {
  const initial: ReplaySnapshot = {
    nodes: {},
    edges: [],
    path: [],
    current: "",
    iteration: 0,
    k: 0,
  };
  return advanceReplay(
    initial,
    cursor === Infinity
      ? events
      : events.filter((event) => event.sequence <= cursor),
  );
}
