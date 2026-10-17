import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  ChevronDown,
  CircleStop,
  GitBranch,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
} from "lucide-react";
import { api } from "./api";
import type { LabEvent } from "./api";
import { ErrorBox, Exports, Panel, Title, WordInput } from "./components";
import { Graph } from "./Graph";
import { advanceReplay, mergeEvents, replay, useWorkspace } from "./store";
import type { ReplaySnapshot } from "./store";

const labels: Record<string, string> = {
  events_compacted: "履歴をローカルに退避",
  search_started: "探索開始",
  iteration_started: "固定グラフを準備",
  node_discovered: "候補を発見",
  node_updated: "より短い経路へ更新",
  node_expanded: "ノードを展開",
  edge_observed: "近傍辺を確認",
  goal_found: "目標に到達",
  iteration_exhausted: "次の近傍数へ拡張",
  search_completed: "探索完了",
  search_failed: "探索を終了",
  search_cancelled: "キャンセル",
};
const reasons: Record<string, string> = {
  NO_ROUTE_IN_GRAPH: "指定グラフで到達不能",
  MAX_EXPANSIONS: "展開数の上限",
  TIMEOUT: "時間の上限",
  CANCELLED: "キャンセル",
  RESOURCE_LIMIT: "リソース上限",
  GOAL_FOUND: "目標に到達",
};
function indexThrough(events: LabEvent[], sequence: number): number {
  let first = 0,
    last = events.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (events[middle].sequence <= sequence) first = middle + 1;
    else last = middle;
  }
  return first;
}
export default function Search() {
  const {
    modelId,
    experiment,
    select: selectWord,
    inspectNode,
    project,
    jobId: storedJob,
    setJob,
  } = useWorkspace();
  const navigate = useNavigate(),
    [params, setParams] = useSearchParams();
  const jobId =
    params.get("job") ||
    (params.has("start") || params.has("goal") ? null : storedJob);
  const [start, setStart] = useState(params.get("start") || "猫"),
    [goal, setGoal] = useState(params.get("goal") || "宇宙");
  const [strategy, setStrategy] = useState<"reach_first" | "optimal">("reach_first"),
    [k, setK] = useState(100),
    [penalty, setPenalty] = useState(0.15),
    [maxExpansions, setMaxExpansions] = useState(5000),
    [timeout, setTimeoutValue] = useState(30);
  const [widen, setWiden] = useState(false),
    [exclude, setExclude] = useState(""),
    [regex, setRegex] = useState(""),
    [minCount, setMinCount] = useState("");
  const [advanced, setAdvanced] = useState(false),
    [startPaused, setStartPaused] = useState(false);
  const [events, setEvents] = useState<LabEvent[]>([]),
    incoming = useRef<LabEvent[]>([]);
  const replayCache = useRef<{
    events: LabEvent[];
    snapshot: ReplaySnapshot;
  } | null>(null);
  const playbackCache = useRef<{
    events: LabEvent[];
    cursor: number;
    index: number;
    snapshot: ReplaySnapshot;
  } | null>(null);
  const contiguous = useRef(0);
  const activeJob = useRef(jobId);
  const [status, setStatus] = useState("idle"),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<number | null>(null),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(150);
  const [tab, setTab] = useState("graph"),
    [focus, setFocus] = useState(false),
    [edgeLabels, setEdgeLabels] = useState(false),
    [size, setSize] = useState("goal");
  const [submitting, setSubmitting] = useState(false),
    [nodePage, setNodePage] = useState(0);
  const refresh = useCallback(async () => {
    if (!jobId) return;
    const response = await api(
      `/searches/${jobId}?after_sequence=${contiguous.current}`,
    );
    if (activeJob.current !== jobId) return;
    incoming.current.push(...response.events);
    setStatus(response.status);
    setResult(response.result);
  }, [jobId]);
  useEffect(() => {
    if (params.get("start")) setStart(params.get("start")!);
    if (params.get("goal")) setGoal(params.get("goal")!);
  }, [params]);
  useEffect(() => {
    activeJob.current = jobId;
    setEvents([]);
    replayCache.current = null;
    playbackCache.current = null;
    incoming.current = [];
    contiguous.current = 0;
    setCursor(null);
    setResult(null);
    setError(null);
    setStatus(jobId ? "queued" : "idle");
    if (!jobId) return;
    let active = true;
    const sync = () =>
      refresh().catch((e) => {
        if (active) setError(e);
      });
    void sync();
    const source = new EventSource(`/api/v1/searches/${jobId}/events`);
    const receive = (event: MessageEvent) => {
      if (!active) return;
      const data = JSON.parse(event.data) as LabEvent;
      incoming.current.push(data);
      if (
        ["search_completed", "search_failed", "search_cancelled"].includes(
          data.type,
        )
      ) {
        source.close();
        void sync();
      }
    };
    for (const name of Object.keys(labels))
      source.addEventListener(name, receive as EventListener);
    source.onerror = () => {
      void sync();
    };
    const poll = setInterval(sync, 1500);
    const batch = setInterval(() => {
      if (incoming.current.length) {
        const update = incoming.current;
        incoming.current = [];
        setEvents((previous) => {
          const merged = mergeEvents(previous, update);
          let sequence = 0;
          for (const e of merged) {
            if (e.sequence !== sequence + 1) break;
            sequence = e.sequence;
          }
          contiguous.current = sequence;
          return merged;
        });
      }
    }, 500);
    return () => {
      active = false;
      source.close();
      clearInterval(poll);
      clearInterval(batch);
    };
  }, [jobId, refresh]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setCursor((value) => {
          const next = (value ?? 0) + 1;
          if (next >= events.length) {
            setPlaying(false);
            return null;
          }
          return next;
        }),
      speed,
    );
    return () => clearInterval(timer);
  }, [playing, speed, events.length]);
  const liveSnapshot = useMemo(() => {
    const previous = replayCache.current;
    const prefix = previous?.events.length ?? 0;
    const canAdvance =
      previous &&
      prefix <= events.length &&
      (!prefix || previous.events[prefix - 1] === events[prefix - 1]);
    const snapshot = canAdvance
      ? advanceReplay(previous.snapshot, events.slice(prefix))
      : replay(events);
    replayCache.current = { events, snapshot };
    return snapshot;
  }, [events]);
  const snapshot = useMemo(() => {
    if (cursor === null) return liveSnapshot;
    const index = indexThrough(events, cursor);
    const previous = playbackCache.current;
    const canAdvance =
      previous &&
      cursor >= previous.cursor &&
      previous.index <= index &&
      (!previous.index ||
        previous.events[previous.index - 1] === events[previous.index - 1]);
    const next = canAdvance
      ? advanceReplay(previous.snapshot, events.slice(previous.index, index))
      : replay(events, cursor);
    playbackCache.current = { events, cursor, index, snapshot: next };
    return next;
  }, [events, cursor, liveSnapshot]);
  const select = (word: string) =>
    snapshot.nodes[word]
      ? inspectNode(snapshot.nodes[word], jobId || undefined)
      : selectWord(word);
  const running = ["queued", "running", "paused"].includes(status);
  const latest = events.find((e) => e.type === "search_started");
  const actualStart = latest?.settings?.start || start,
    actualGoal = latest?.settings?.goal || goal;
  const nodeList = Object.values(snapshot.nodes);
  const currentNode = snapshot.nodes[snapshot.current];
  const begin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const response = await api("/searches", {
        model_id: modelId,
        experiment_id: experiment?.id,
        start: start.trim(),
        goal: goal.trim(),
        strategy,
        neighbor: {
          mode: "exact",
          k,
          progressive_widening: widen ? [10, 25, 50, 100] : [],
        },
        cost: { kind: "angular_with_hop_penalty", lambda: penalty },
        limits: { max_expansions: maxExpansions, timeout_seconds: timeout },
        filters: {
          exclude: exclude.split(/[\s,、]+/).filter(Boolean),
          regex: regex || null,
          min_count: minCount === "" ? null : Number(minCount),
        },
        start_paused: startPaused,
      });
      setJob(response.search_id);
      setParams({ job: response.search_id });
      setCursor(null);
      setNodePage(0);
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  };
  const control = async (action: string) => {
    try {
      await api(
        `/searches/${jobId}${action === "cancel" ? "" : "/" + action}`,
        undefined,
        action === "cancel" ? "DELETE" : "POST",
      );
      await refresh();
    } catch (e) {
      setError(e);
    }
  };
  const toProjection = () => {
    const words = snapshot.path.length
      ? snapshot.path
      : cursor === null && result?.provisional_path?.length
        ? result.provisional_path
        : Object.keys(snapshot.nodes);
    project(
      words,
      [],
      Object.fromEntries(
        words.map((w: string) => [
          w,
          w === actualStart ? "start" : w === actualGoal ? "goal" : "path",
        ]),
      ),
    );
    navigate("/projection");
  };
  return (
    <>
      <Title
        eyebrow="EXPLORE THE CONNECTIONS"
        title="言葉から、言葉への旅。"
        description="関連する言葉をたどって、ふたつの単語をつなぐ道筋を観察しましょう。"
      >
        <span className="tag">
          <Sparkles size={13} /> A* 連想探索
        </span>
      </Title>
      <section className="search-form panel">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void begin();
          }}
        >
          <div className="journey-fields">
            <WordInput
              label="出発する言葉"
              value={start}
              onChange={setStart}
              required
            />
            <button
              type="button"
              className="swap"
              title="出発語と目標語を入れ替える"
              aria-label="出発語と目標語を入れ替える"
              onClick={() => {
                setStart(goal);
                setGoal(start);
              }}
            >
              <ArrowRightLeft size={18} />
            </button>
            <WordInput
              label="たどり着きたい言葉"
              value={goal}
              onChange={setGoal}
              required
            />
            <button
              className="button primary begin"
              disabled={running || submitting}
            >
              <Play size={16} />
              {submitting ? "準備中…" : "探索をはじめる"}
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="settings-row">
            <label>
              探索方針{" "}
              <select
                aria-label="探索方針"
                value={strategy}
                onChange={(e) => {
                  const next = e.target.value as "reach_first" | "optimal";
                  setStrategy(next);
                  setK(next === "reach_first" ? 100 : 25);
                  setWiden(next === "optimal");
                }}
              >
                <option value="reach_first">到達優先</option>
                <option value="optimal">最小コスト</option>
              </select>
            </label>
            <label>
              近傍数{" "}
              <input
                aria-label="近傍数"
                type="number"
                min={2}
                max={200}
                value={k}
                disabled={widen}
                onChange={(e) => setK(Number(e.target.value))}
              />
            </label>
            <span className="divider" />
            <label>
              1手のペナルティ{" "}
              <input
                aria-label="1手のペナルティ"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={penalty}
                onChange={(e) => setPenalty(Number(e.target.value))}
              />
            </label>
            {strategy === "optimal" && <label className="check">
              <input
                type="checkbox"
                checked={widen}
                onChange={(e) => setWiden(e.target.checked)}
              />
              段階的に探索を広げる
            </label>}
            <button
              type="button"
              className="text-button advanced"
              onClick={() => setAdvanced(!advanced)}
            >
              詳細設定 <ChevronDown size={14} />
            </button>
          </div>
          {strategy === "reach_first" && (
            <div className="inline-note">
              目標への到達を優先して近傍グラフを探索します。見つかった経路の最小コストは保証しません。
            </div>
          )}
          {strategy === "optimal" && widen && (
            <div className="inline-note">
              近傍数 10 → 25 → 50 → 100 の独立したグラフを順に探索します。
            </div>
          )}
          {advanced && (
            <div className="advanced-grid">
              <label className="field">
                <span>最大展開数</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={maxExpansions}
                  onChange={(e) => setMaxExpansions(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>時間上限（秒）</span>
                <input
                  type="number"
                  min={0.01}
                  max={300}
                  step={0.01}
                  value={timeout}
                  onChange={(e) => setTimeoutValue(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>除外語（空白区切り）</span>
                <input
                  value={exclude}
                  onChange={(e) => setExclude(e.target.value)}
                />
              </label>
              <label className="field">
                <span>許可する正規表現</span>
                <input
                  value={regex}
                  onChange={(e) => setRegex(e.target.value)}
                />
              </label>
              <label className="field">
                <span>最小頻度（不明な語は除外）</span>
                <input
                  type="number"
                  min={0}
                  value={minCount}
                  onChange={(e) => setMinCount(e.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={startPaused}
                  onChange={(e) => setStartPaused(e.target.checked)}
                />
                一時停止状態で開始
              </label>
              <p className="muted">近傍方式：exact（完全検索）</p>
            </div>
          )}
        </form>
        <ErrorBox error={error} />
      </section>
      <div className="search-metrics">
        <div>
          <span className={"status-dot " + (running ? "pulse" : "")} />
          <span aria-live="polite">
            {status === "idle"
              ? "新しい探索を待っています"
              : status === "paused"
                ? "一時停止中"
                : status === "running" || status === "queued"
                  ? "探索しています"
                  : reasons[result?.code] || status}
          </span>
        </div>
        <dl>
          <div>
            <dt>発見</dt>
            <dd>
              {nodeList.length}
              <small>語</small>
            </dd>
          </div>
          <div>
            <dt>展開</dt>
            <dd>
              {nodeList.filter((n) => n.state === "closed").length}
              <small>語</small>
            </dd>
          </div>
          <div>
            <dt>OPEN</dt>
            <dd>{nodeList.filter((n) => n.state === "open").length}</dd>
          </div>
          <div>
            <dt>経過</dt>
            <dd>
              {result ? result.elapsed_seconds?.toFixed(2) : "—"}
              <small>秒</small>
            </dd>
          </div>
        </dl>
      </div>
      <section className="panel exploration">
        <div className="graph-toolbar">
          <div className="tabs">
            <button
              className={tab === "graph" ? "active" : ""}
              onClick={() => setTab("graph")}
            >
              <GitBranch size={15} />
              探索グラフ
            </button>
            <button
              className={tab === "nodes" ? "active" : ""}
              onClick={() => setTab("nodes")}
            >
              ノード一覧 <span>{nodeList.length}</span>
            </button>
          </div>
          <div className="graph-options">
            <label>
              <input
                type="checkbox"
                checked={focus}
                onChange={(e) => setFocus(e.target.checked)}
              />
              道筋のみ
            </label>
            <label>
              <input
                type="checkbox"
                checked={edgeLabels}
                onChange={(e) => setEdgeLabels(e.target.checked)}
              />
              辺スコア
            </label>
            <select
              aria-label="ノードサイズ"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              <option value="goal">目標への近さ</option>
              <option value="fixed">同じサイズ</option>
            </select>
          </div>
        </div>
        {tab === "graph" ? (
          nodeList.length ? (
            <Graph
              key={`${jobId}:${snapshot.iteration}`}
              nodes={snapshot.nodes}
              edges={snapshot.edges}
              path={snapshot.path}
              current={snapshot.current}
              start={actualStart}
              goal={actualGoal}
              focus={focus}
              labels={edgeLabels}
              size={size}
              select={select}
              maxNodes={running ? 500 : 1000}
              maxEdges={running ? 1200 : 2500}
              condensed
            />
          ) : (
            <div className="graph-empty">
              <div className="empty-orbit">
                <span>猫</span>
                <i />
                <span>？</span>
                <i />
                <span>宇宙</span>
              </div>
              <h3>言葉のあいだに、どんなつながりがあるだろう。</h3>
              <p>出発する言葉と目標を選んで、最初の探索をはじめましょう。</p>
              <div className="example-buttons">
                <button
                  onClick={() => {
                    setStart("猫");
                    setGoal("宇宙");
                  }}
                >
                  猫 → 宇宙
                </button>
                <button
                  onClick={() => {
                    setStart("自然");
                    setGoal("星");
                  }}
                >
                  自然 → 星
                </button>
                <button
                  onClick={() => {
                    setStart("東京");
                    setGoal("北京");
                  }}
                >
                  東京 → 北京
                </button>
              </div>
            </div>
          )
        ) : (
          <div className="table-scroll nodes-table">
            <table>
              <thead>
                <tr>
                  <th>単語 / 状態</th>
                  <th>g</th>
                  <th>h</th>
                  <th>f</th>
                  <th>深さ</th>
                  <th>親</th>
                  <th>発見 / 展開順</th>
                </tr>
              </thead>
              <tbody>
                {nodeList
                  .slice(nodePage * 100, (nodePage + 1) * 100)
                  .map((n) => (
                    <tr key={n.word}>
                      <td>
                        <button
                          className="word-link"
                          onClick={() => select(n.word)}
                        >
                          {n.word}
                        </button>{" "}
                        <small>
                          {snapshot.path.includes(n.word) ? "経路" : n.state}
                        </small>
                      </td>
                      <td>{n.g.toFixed(4)}</td>
                      <td>{n.h.toFixed(4)}</td>
                      <td>{n.f.toFixed(4)}</td>
                      <td>{n.depth}</td>
                      <td>{n.parent || "—"}</td>
                      <td>
                        {n.discovered_sequence} / {n.expanded_sequence || "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="pagination">
              <button
                disabled={!nodePage}
                onClick={() => setNodePage(nodePage - 1)}
              >
                前へ
              </button>
              <span>
                {nodePage + 1} / {Math.max(1, Math.ceil(nodeList.length / 100))}
              </span>
              <button
                disabled={(nodePage + 1) * 100 >= nodeList.length}
                onClick={() => setNodePage(nodePage + 1)}
              >
                次へ
              </button>
            </div>
          </div>
        )}
        <div className="graph-footer">
          <div className="legend">
            {[
              ["start", "出発"],
              ["goal", "目標"],
              ["open", "候補"],
              ["closed", "展開済み"],
              ["current", "現在"],
              ["path", "経路"],
            ].map(([c, l]) => (
              <span key={c}>
                <i className={"legend-" + c} />
                {l}
              </span>
            ))}
          </div>
          <span className="muted">
            有向 top-k グラフ · exact{" "}
            {snapshot.k ? `· k=${snapshot.k} · 試行 ${snapshot.iteration}` : ""}
          </span>
        </div>
      </section>
      {result && (
        <div
          className={
            "result-strip " + (status === "succeeded" ? "success" : "failure")
          }
          aria-live="polite"
        >
          <div className="result-heading">
            {status === "succeeded" ? (
              <Check size={19} />
            ) : (
              <CircleStop size={19} />
            )}
            <strong>{reasons[result.code] || result.code}</strong>
            <span>
              {status === "succeeded"
                ? `${result.path.length - 1}ステップ · 総コスト ${result.total_cost?.toFixed(5)}`
                : result.message}
            </span>
          </div>
          <div className="path-chips">
            {(result.path?.length
              ? result.path
              : result.provisional_path || []
            ).map((word: string, i: number) => (
              <span key={word}>
                {i > 0 && <ArrowRight size={12} />}
                <button onClick={() => select(word)}>{word}</button>
              </span>
            ))}
          </div>
          <p>
             {result.optimal_within_fixed_graph
              ? `k=${result.k} の固定有向グラフ内で最小コスト。人間にとっての自然な連想を保証するものではありません。`
               : status === "succeeded"
                 ? `k=${result.k} の固定有向グラフ内で目標に到達しました。到達を優先した経路で、最小コストは保証しません。`
              : `暫定経路です。最良候補：${result.best_word || "—"}。語彙全体で到達不能とは限りません。`}
          </p>
          {result.trials?.length > 0 && (
            <p>
              試行：
              {result.trials
                .map(
                  (t: any) =>
                    `k=${t.k} ${t.status === "succeeded" ? "到達" : "経路なし"} (${t.expansions}展開)`,
                )
                .join(" → ")}
            </p>
          )}
          <div className="result-actions">
            <Exports kind="search" searchId={jobId || undefined} />
            <button className="text-button" onClick={toProjection}>
              この言葉を可視化 <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
      <Panel
        title="探索のタイムライン"
        subtitle="任意の時点に戻り、候補が広がる過程を観察できます。"
        action={<span className="tag neutral">{events.length} EVENTS</span>}
      >
        <div className="playback">
          <button
            className="icon-button"
            aria-label="最初へ戻す"
            onClick={() => {
              setCursor(0);
              setPlaying(false);
            }}
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={playing ? "再生を停止" : "タイムラインを再生"}
            disabled={!events.length}
            onClick={() => {
              if (cursor === null) setCursor(0);
              setPlaying(!playing);
            }}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <input
            aria-label="タイムラインの位置"
            type="range"
            min={0}
            max={Math.max(1, events.length)}
            value={cursor ?? events.length}
            onChange={(e) => {
              setPlaying(false);
              setCursor(Number(e.target.value));
            }}
          />
          <span className="mono">
            {cursor ?? events.length} / {events.length}
          </span>
          <select
            aria-label="再生速度"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            <option value={500}>ゆっくり</option>
            <option value={150}>標準</option>
            <option value={30}>速い</option>
          </select>
          <button
            className="text-button"
            onClick={() => {
              setCursor(null);
              setPlaying(false);
            }}
          >
            最新へ
          </button>
        </div>
        {running && (
          <div className="job-controls">
            <button
              className="button small"
              onClick={() => control(status === "paused" ? "resume" : "pause")}
            >
              {status === "paused" ? <Play size={14} /> : <Pause size={14} />}{" "}
              {status === "paused" ? "探索を再開" : "探索を一時停止"}
            </button>
            <button className="button small" onClick={() => control("step")}>
              <SkipForward size={14} />
              1ステップ
            </button>
            <button
              className="button small danger"
              onClick={() => control("cancel")}
            >
              <CircleStop size={14} />
              キャンセル
            </button>
          </div>
        )}
        <div className="timeline-current">
          {snapshot.last ? (
            <>
              <span className="event-marker" />
              <span className="mono">#{snapshot.last.sequence}</span>
              <strong>{labels[snapshot.last.type]}</strong>
              <button
                className="word-link"
                onClick={() => select(snapshot.last?.word || snapshot.current)}
              >
                {snapshot.last.word || ""}
              </button>
              {currentNode && (
                <span className="muted">
                  g {currentNode.g.toFixed(3)} · h {currentNode.h.toFixed(3)} ·
                  f {currentNode.f.toFixed(3)}
                </span>
              )}
            </>
          ) : (
            <span className="muted">
              探索を開始するとイベントがここに記録されます。
            </span>
          )}
        </div>
        <details className="timeline-details">
          <summary>イベント一覧を表示</summary>
          <ol>
            {events
              .slice(
                Math.max(0, (cursor ?? events.length) - 150),
                cursor ?? events.length,
              )
              .map((e) => (
                <li key={e.sequence}>
                  <button
                    onClick={() => {
                      setCursor(e.sequence);
                      if (e.word) select(e.word);
                    }}
                  >
                    <span className="mono">{e.sequence}</span>
                    {labels[e.type]} <strong>{e.word}</strong>
                  </button>
                </li>
              ))}
          </ol>
          <p className="muted">
            現在の位置までの直近150件を表示。全イベントはJSON /
            ZIPで取得できます。
          </p>
        </details>
      </Panel>
      <div className="footnote">
        <GitBranch size={14} />
        <p>
          探索は言葉の共起傾向をもとにした実験です。
          <button className="text-button" onClick={() => navigate("/help")}>
            アルゴリズムと解釈の限界について
          </button>
        </p>
      </div>
    </>
  );
}
