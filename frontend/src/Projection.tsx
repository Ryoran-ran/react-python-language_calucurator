import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowRight, Box, RotateCcw } from "lucide-react";
import { api, ApiError } from "./api";
import { ErrorBox, Exports, Panel, Pending, Title } from "./components";
import { useWorkspace } from "./store";

const Plot = lazy(() => import("./Plot"));
export default function Projection() {
  const {
    projectionWords,
    projectionVectors,
    projectionRoles,
    modelId,
    experiment,
    select,
  } = useWorkspace();
  const [words, setWords] = useState(
    projectionWords.length
      ? projectionWords.join("、")
      : "猫、犬、動物、生物、自然、地球、太陽、星、銀河、宇宙",
  );
  const [method, setMethod] = useState("pca"),
    [dimensions, setDimensions] = useState(2),
    [seed, setSeed] = useState(42),
    [perplexity, setPerplexity] = useState(3);
  const [result, setResult] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [revision, setRevision] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    setResult(null);
    setError(null);
    setJobId(null);
    setBusy(false);
  }, [modelId, experiment?.id, experiment?.revision]);
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const job = await api("/projection-jobs", {
        model_id: modelId,
        experiment_id: experiment?.id,
        words: words.split(/[\s,、]+/).filter(Boolean),
        vectors: projectionVectors,
        roles: projectionRoles,
        method,
        dimensions,
        seed,
        parameters: method === "tsne" ? { perplexity } : {},
      });
      setJobId(job.projection_id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const job = await api(`/projection-jobs/${jobId}`);
        if (!active) return;
        if (job.status === "succeeded") {
          setResult(job.result);
          setBusy(false);
          setJobId(null);
        } else if (job.error) {
          setError(new ApiError(job.error));
          setBusy(false);
          setJobId(null);
        }
      } catch (e) {
        if (active) {
          setError(e);
          setBusy(false);
          setJobId(null);
        }
      }
    }, 250);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [jobId]);
  useEffect(
    () => () => {
      if (jobId) void api(`/projection-jobs/${jobId}`, undefined, "DELETE");
    },
    [jobId],
  );
  const scatter: any = result
    ? {
        type: result.dimensions === 3 ? "scatter3d" : "scatter",
        mode: "markers+text",
        x: result.points.map((p: any) => p.coordinates[0]),
        y: result.points.map((p: any) => p.coordinates[1]),
        ...(result.dimensions === 3
          ? { z: result.points.map((p: any) => p.coordinates[2]) }
          : {}),
        text: result.points.map((p: any) => p.word),
        textposition: "top center",
        customdata: result.points.map((p: any) => p.word),
        hovertemplate: "%{text}<extra></extra>",
        marker: {
          size: result.dimensions === 3 ? 6 : 12,
          color: result.points.map((p: any) =>
            p.edited
              ? "#d99157"
              : p.role === "start"
                ? "#5b85b6"
                : p.role === "goal"
                  ? "#c79d3c"
                  : p.role === "result"
                    ? "#946db0"
                    : "#548b70",
          ),
          line: { color: "#ffffff", width: 2 },
        },
        textfont: { color: "#3f594b", size: 12 },
      }
    : null;
  return (
    <>
      <Title
        eyebrow="A DIFFERENT PERSPECTIVE"
        title="言葉の空間を、眺める。"
        description="高次元の関係を2D・3Dに映して、別の角度から観察します。"
      />
      <Panel title="可視化する言葉" action={<Box size={18} />}>
        <form
          className="padded"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label className="field">
            <span>対象語（重複は1点にまとめます・最大5000語）</span>
            <textarea
              value={words}
              onChange={(e) => setWords(e.target.value)}
              rows={3}
              required
            />
          </label>
          <div className="advanced-grid">
            <label className="field">
              <span>射影手法</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="pca">PCA · 決定的な線形射影</option>
                <option value="tsne">t-SNE · 局所構造</option>
              </select>
            </label>
            <label className="field">
              <span>表示次元</span>
              <select
                value={dimensions}
                onChange={(e) => setDimensions(Number(e.target.value))}
              >
                <option value={2}>2D</option>
                <option value={3}>3D</option>
              </select>
            </label>
            <label className="field">
              <span>ランダムシード</span>
              <input
                type="number"
                min={0}
                max={4294967295}
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
              />
            </label>
            {method === "tsne" && (
              <label className="field">
                <span>perplexity（点数未満）</span>
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={perplexity}
                  onChange={(e) => setPerplexity(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <div className="form-actions">
            <span className="muted">PCAは同じ入力順と設定で再現できます。</span>
            <button className="button primary" disabled={busy}>
              空間を描く <ArrowRight size={15} />
            </button>
          </div>
          <ErrorBox error={error} />
          {busy && (
            <>
              <Pending />
              <button
                type="button"
                className="button small danger"
                onClick={() => {
                  if (jobId)
                    void api(`/projection-jobs/${jobId}`, undefined, "DELETE");
                }}
              >
                射影をキャンセル
              </button>
            </>
          )}
        </form>
      </Panel>
      <div className="notice persistent">
        低次元の射影では、距離や近傍関係が歪みます。t-SNEの軸・クラスタ間距離や、別の対象集合から計算した座標を直接比較しないでください。
      </div>
      {result && (
        <>
          <Panel
            title={`${result.method.toUpperCase()} · ${result.dimensions}D`}
            subtitle={`${result.points.length}語 · seed ${result.seed} · revision ${result.experiment_revision ?? "基底"}`}
            action={
              <div className="result-actions">
                <button
                  className="icon-button"
                  aria-label="視点をリセット"
                  onClick={() => setRevision(revision + 1)}
                >
                  <RotateCcw size={15} />
                </button>
                <Exports
                  kind="projection"
                  payload={result.settings}
                  projectionId={result.projection_id}
                />
              </div>
            }
          >
            <Suspense fallback={<Pending />}>
              <Plot
                key={revision}
                data={[scatter]}
                layout={{
                  height: 490,
                  margin: { l: 40, r: 40, t: 35, b: 40 },
                  paper_bgcolor: "#fcfdfb",
                  plot_bgcolor: "#fcfdfb",
                  font: { family: "sans-serif", color: "#6a7a70" },
                  xaxis: {
                    zeroline: false,
                    gridcolor: "#e7ece5",
                    title: { text: "表示軸 1" },
                  },
                  yaxis: {
                    zeroline: false,
                    gridcolor: "#e7ece5",
                    title: { text: "表示軸 2" },
                  },
                  scene: {
                    xaxis: { title: { text: "表示軸 1" } },
                    yaxis: { title: { text: "表示軸 2" } },
                    zaxis: { title: { text: "表示軸 3" } },
                  },
                }}
                config={{
                  responsive: true,
                  displaylogo: false,
                  scrollZoom: true,
                }}
                useResizeHandler
                style={{ width: "100%" }}
                onClick={(event) => {
                  const w = event.points[0]?.customdata;
                  if (
                    typeof w === "string" &&
                    result.points.find((p: any) => p.word === w)?.kind ===
                      "word"
                  )
                    select(w);
                }}
              />
            </Suspense>
            <div className="graph-footer">
              <span className="muted">
                ドラッグで移動・回転 · スクロールでズーム
              </span>
              <span className="tag neutral">
                ● 基底 <span className="orange">● 編集あり</span>
              </span>
            </div>
          </Panel>
          <Panel
            title="射影座標"
            subtitle="グラフと同じ情報を表でも確認できます。"
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>単語</th>
                    <th>表示軸1</th>
                    <th>表示軸2</th>
                    {result.dimensions === 3 && <th>表示軸3</th>}
                    <th>元の入力位置</th>
                    <th>編集</th>
                  </tr>
                </thead>
                <tbody>
                  {result.points.map((p: any) => (
                    <tr key={p.id}>
                      <td>
                        <button
                          className="word-link"
                          disabled={p.kind === "vector"}
                          onClick={() => select(p.word)}
                        >
                          {p.word}
                        </button>
                      </td>
                      {p.coordinates.map((v: number, i: number) => (
                        <td key={i}>{v.toFixed(6)}</td>
                      ))}
                      <td>{p.input_positions.join(", ")}</td>
                      <td>{p.edited ? "あり" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
