import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  Calculator,
  Check,
  Eye,
  FlaskConical,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Expression } from "./expression";
import { parseExpression } from "./expression";
import { api } from "./api";
import {
  ErrorBox,
  Exports,
  Panel,
  Pending,
  Ranking,
  Stats,
  Title,
  WordInput,
} from "./components";
import { useWorkspace } from "./store";

const Plot = lazy(() => import("./Plot"));
const plotLayout = {
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
  font: { family: "sans-serif", size: 11, color: "#69796f" },
  margin: { l: 42, r: 20, t: 15, b: 38 },
  height: 240,
};
function useContext() {
  const { modelId, experiment } = useWorkspace();
  return useMemo(
    () => ({
      model_id: modelId,
      experiment_id: experiment?.id,
      revision: experiment?.revision,
    }),
    [modelId, experiment?.id, experiment?.revision],
  );
}
function clean(context: ReturnType<typeof useContext>) {
  return { model_id: context.model_id, experiment_id: context.experiment_id };
}
export function Arithmetic() {
  const context = useContext(),
    navigate = useNavigate(),
    project = useWorkspace((s) => s.project),
    selectWord = useWorkspace((s) => s.select);
  const [a, setA] = useState("東京"),
    [b, setB] = useState("日本"),
    [c, setC] = useState("中国");
  const [operator1, setOperator1] = useState("-"),
    [operator2, setOperator2] = useState("+"),
    [scale, setScale] = useState(1);
  const [text, setText] = useState("[東京] - [日本] + [中国]"),
    [mode, setMode] = useState("text"),
    [exclude, setExclude] = useState(true),
    [topN, setTopN] = useState(20);
  const formulaInput = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<any>(null),
    [resultKey, setResultKey] = useState(""),
    [showAll, setShowAll] = useState(false),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [context]);
  const wordOperand = (word: string) =>
    `[${word.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}]`;
  const baseFormula = `${wordOperand(a)} ${operator1} ${wordOperand(b)} ${operator2} ${wordOperand(c)}`;
  const builderFormula =
    scale === 1 ? baseFormula : `(${baseFormula}) × ${scale}`;
  const expressionText =
    mode === "text" ? text : builderFormula.replace("×", "*");
  const displayedFormula = mode === "text" ? text : builderFormula;
  const inputKey = JSON.stringify([
    expressionText,
    exclude,
    topN,
    context.model_id,
    context.experiment_id,
    context.revision,
  ]);
  const visibleResult = resultKey === inputKey ? result : null;
  const closest = visibleResult?.ranking?.[0];
  const answerPreview = visibleResult && (
    <div className="arithmetic-answer" role="status">
      <span>この計算に最も近い言葉</span>
      {closest ? (
        <div>
          <span className="arithmetic-approx">≈</span>
          <strong>{closest.word}</strong>
          <small>類似度 {closest.cosine_similarity.toFixed(3)}</small>
        </div>
      ) : (
        <strong>条件に合う言葉がありません</strong>
      )}
    </div>
  );
  const insertFormula = (value: string, cursorBack = 0) => {
    const input = formulaInput.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const next = text.slice(0, start) + value + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      input?.focus();
      const cursor = start + value.length - cursorBack;
      input?.setSelectionRange(cursor, cursor);
    });
  };
  let expression: Expression | null = null,
    syntax = "";
  try {
    expression = parseExpression(expressionText);
  } catch (e) {
    syntax = (e as Error).message;
  }
  const run = async () => {
    if (!expression) return;
    setBusy(true);
    setShowAll(false);
    setError(null);
    try {
      const response = await api("/arithmetic/evaluate", {
        ...clean(context),
        expression,
        top_n: topN,
        exclude_input_words: exclude,
      });
      setResult(response);
      setResultKey(inputKey);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="PLAY WITH VECTORS"
        title="言葉を、計算してみる。"
        description="足して、引いて、かけて。ベクトルの線形な規則性を実験します。"
      />
      <Panel
        title="ベクトル演算ビルダー"
        action={
          <div className="tabs compact">
            <button
              className={mode === "text" ? "active" : ""}
              onClick={() => {
                if (mode === "builder") setText(expressionText);
                setMode("text");
              }}
            >
              式入力
            </button>
            <button
              className={mode === "builder" ? "active" : ""}
              onClick={() => setMode("builder")}
            >
              かんたんフォーム
            </button>
          </div>
        }
      >
        <form
          className="padded"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {mode === "builder" ? (
            <div className="arithmetic-builder">
              <WordInput label="単語 A" value={a} onChange={setA} />
              <select
                aria-label="最初の演算子"
                value={operator1}
                onChange={(e) => setOperator1(e.target.value)}
              >
                <option>-</option>
                <option>+</option>
              </select>
              <WordInput label="単語 B" value={b} onChange={setB} />
              <select
                aria-label="2番目の演算子"
                value={operator2}
                onChange={(e) => setOperator2(e.target.value)}
              >
                <option>+</option>
                <option>-</option>
              </select>
              <WordInput label="単語 C" value={c} onChange={setC} />
              <label className="field">
                <span>全体のスカラー倍</span>
                <input
                  type="number"
                  min={-1000000}
                  max={1000000}
                  step={0.1}
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                />
              </label>
            </div>
          ) : (
            <div className="formula-workspace">
              <div className="arithmetic-entry-row">
                <label className="field">
                  <span>計算式</span>
                  <div className="formula-editor">
                    <Calculator aria-hidden="true" size={19} />
                    <input
                      ref={formulaInput}
                      className="formula"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="[東京] - [日本] + [中国]"
                      aria-label="計算式"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </label>
                <button className="button primary arithmetic-calculate" disabled={busy || !expression}>
                  <Calculator size={16} />
                  計算する
                </button>
              </div>
              {answerPreview}
              <div className="formula-keypad" aria-label="演算子を挿入">
                {[
                  ["＋", " + ", 0],
                  ["−", " − ", 0],
                  ["×", " × ", 0],
                  ["÷", " ÷ ", 0],
                  ["( )", "()", 1],
                  ["[単語]", "[]", 1],
                ].map(([label, value, cursorBack]) => (
                  <button
                    key={label}
                    type="button"
                    className="formula-key"
                    onClick={() =>
                      insertFormula(String(value), Number(cursorBack))
                    }
                    aria-label={`${label}を式に挿入`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="formula-help">
                単語は [ ] で囲みます。例：[王] − [男] ＋
                [女]。乗除算はベクトルと数値の組み合わせで使えます。
              </p>
            </div>
          )}
          {mode === "builder" && (
            <>
              <div className="arithmetic-entry-row arithmetic-builder-row">
                <div className="formula-preview">
                  <Calculator size={17} />
                  <code>{displayedFormula}</code>
                </div>
                <button className="button primary arithmetic-calculate" disabled={busy || !expression}>
                  <Calculator size={16} />
                  計算する
                </button>
              </div>
              {answerPreview}
            </>
          )}
          {syntax && (
            <p className="error-text" role="alert">
              {syntax}
            </p>
          )}
          <ErrorBox error={error} />
          {busy && <Pending />}
          <details className="arithmetic-options">
            <summary>計算オプション</summary>
            <div className="form-actions">
              <label className="check">
                <input
                  type="checkbox"
                  checked={exclude}
                  onChange={(e) => setExclude(e.target.checked)}
                />
                入力語をランキングから除外
              </label>
              <label>
                上位{" "}
                <input
                  aria-label="ランキング件数"
                  className="number-small"
                  type="number"
                  min={1}
                  max={200}
                  value={topN}
                  onChange={(e) => setTopN(Number(e.target.value))}
                />{" "}
                件
              </label>
            </div>
            <p className="inline-note">
              ベクトル同士の加減算、スカラーとの乗除算に対応。単語同士の乗除算はできません。
            </p>
          </details>
        </form>
      </Panel>
      {visibleResult ? (
        <Panel
          title="ほかに近い言葉"
          subtitle="もっとも近い言葉の次に並ぶ候補"
          action={
            <div className="arithmetic-result-actions">
              <button
                className="text-button"
                onClick={() => {
                  project(
                    visibleResult.ranking.map((r: any) => r.word),
                    [{ label: "演算結果", vector: visibleResult.vector }],
                  );
                  navigate("/projection");
                }}
              >
                可視化へ送る <ArrowRight size={14} />
              </button>
              <Exports kind="arithmetic" payload={visibleResult.settings} />
            </div>
          }
        >
          {showAll ? (
            <Ranking rows={visibleResult.ranking} />
          ) : visibleResult.ranking.length > 1 ? (
            <div className="arithmetic-shortlist">
              {visibleResult.ranking.slice(1, 6).map((row: any, index: number) => (
                <button
                  key={row.word}
                  className="arithmetic-candidate"
                  onClick={() => selectWord(row.word)}
                >
                  <span>{String(index + 2).padStart(2, "0")}</span>
                  <strong>{row.word}</strong>
                  <small>類似度 {row.cosine_similarity.toFixed(3)}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">ほかの候補はありません。</div>
          )}
          {visibleResult.ranking.length > 5 && (
            <div className="arithmetic-more">
              <button className="text-button" onClick={() => setShowAll(!showAll)}>
                {showAll ? "候補5件に戻す" : `全${visibleResult.ranking.length}件と詳しい数値を見る`}
                <ArrowRight size={14} />
              </button>
            </div>
          )}
          <details className="arithmetic-stat-details">
            <summary>ベクトルの統計を見る</summary>
            <Stats stats={visibleResult.statistics} />
          </details>
        </Panel>
      ) : null}
    </>
  );
}

export function Similarity() {
  const context = useContext(),
    [order, setOrder] = useState<"nearest" | "farthest">("nearest"),
    [positive, setPositive] = useState("猫"),
    [negative, setNegative] = useState(""),
    [exclude, setExclude] = useState(""),
    [minimum, setMinimum] = useState(-1),
    [maximum, setMaximum] = useState(1),
    [count, setCount] = useState(20),
    [minFrequency, setMinFrequency] = useState("");
  const [result, setResult] = useState<any>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const split = (value: string) => value.split(/[\s,、]+/).filter(Boolean);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [context]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api("/similarity/rank", {
          ...clean(context),
          positive: split(positive),
          negative: split(negative),
          exclude: split(exclude),
          top_n: count,
          order,
          min_similarity: minimum,
          max_similarity: maximum,
          filters: {
            min_count: minFrequency === "" ? null : Number(minFrequency),
          },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="NEIGHBORHOOD"
        title="近くと遠くにある、言葉たち。"
        description="コサイン類似度で、基準のベクトルに近い言葉と遠い言葉を探します。"
      />
      <Panel title="言葉の距離を探す">
        <form
          className="padded"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div
            className="similarity-direction"
            role="group"
            aria-label="探す方向"
          >
            <button
              type="button"
              aria-pressed={order === "nearest"}
              onClick={() => {
                setOrder("nearest");
                setResult(null);
              }}
            >
              近い言葉
            </button>
            <button
              type="button"
              aria-pressed={order === "farthest"}
              onClick={() => {
                setOrder("farthest");
                setResult(null);
              }}
            >
              遠い言葉
            </button>
          </div>
          <p className="muted similarity-explanation">
            単語の足し引きで基準を作ります。遠い言葉はベクトルの向きが異なる順で、反対語とは限りません。
          </p>
          <div className="two-columns">
            <label className="field">
              <span>足す単語（空白区切り）</span>
              <input
                value={positive}
                onChange={(e) => setPositive(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>引く単語（任意）</span>
              <input
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
              />
            </label>
            <label className="field">
              <span>除外語</span>
              <input
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
              />
            </label>
            {order === "nearest" ? (
              <label className="field">
                <span>最小コサイン類似度</span>
                <input
                  type="number"
                  min={-1}
                  max={1}
                  step={0.1}
                  value={minimum}
                  onChange={(e) => setMinimum(Number(e.target.value))}
                />
              </label>
            ) : (
              <label className="field">
                <span>最大コサイン類似度</span>
                <input
                  type="number"
                  min={-1}
                  max={1}
                  step={0.1}
                  value={maximum}
                  onChange={(e) => setMaximum(Number(e.target.value))}
                />
              </label>
            )}
            <label className="field">
              <span>最小頻度（不明な語は除外）</span>
              <input
                type="number"
                min={0}
                value={minFrequency}
                onChange={(e) => setMinFrequency(e.target.value)}
              />
            </label>
            <label className="field">
              <span>表示件数</span>
              <input
                type="number"
                min={1}
                max={200}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="form-actions">
            <button className="button primary" disabled={busy}>
              {order === "nearest" ? "近い言葉を探す" : "遠い言葉を探す"}{" "}
              <ArrowRight size={15} />
            </button>
          </div>
          <ErrorBox error={error} />
          {busy && <Pending />}
        </form>
      </Panel>
      {result && (
        <Panel
          title={
            result.settings.order === "farthest"
              ? "遠い言葉ランキング"
              : "近い言葉ランキング"
          }
          subtitle={`コサイン類似度が${result.settings.order === "farthest" ? "低い" : "高い"}順。同点は語彙インデックス順です。`}
          action={<Exports kind="similarity" payload={result.settings} />}
        >
          <Ranking
            rows={result.ranking}
            farthest={result.settings.order === "farthest"}
          />
        </Panel>
      )}
    </>
  );
}

export function Distances() {
  const context = useContext(),
    select = useWorkspace((s) => s.select);
  const [params] = useSearchParams();
  const [words, setWords] = useState(
      params.get("words") || "猫、犬、動物、宇宙",
    ),
    [metric, setMetric] = useState("cosine_similarity");
  useEffect(() => {
    if (params.get("words")) setWords(params.get("words")!);
  }, [params]);
  const [result, setResult] = useState<any>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const metrics: Record<string, string> = {
    cosine_similarity: "コサイン類似度",
    cosine_distance: "コサイン距離",
    angular_distance: "角距離",
    euclidean: "ユークリッド距離（生）",
    normalized_euclidean: "ユークリッド距離（L2正規化）",
  };
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [context]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api("/distances/compare", {
          ...clean(context),
          words: words.split(/[\s,、]+/).filter(Boolean),
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="MEASURE THE DISTANCE"
        title="言葉の距離を、比べる。"
        description="異なるものさしで、ベクトルの関係を見てみましょう。"
      />
      <Panel title="比較する言葉">
        <form
          className="padded"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label className="field">
            <span>2〜50語（空白・カンマ・読点区切り）</span>
            <textarea
              value={words}
              onChange={(e) => setWords(e.target.value)}
              rows={2}
              required
            />
          </label>
          <div className="form-actions">
            <span className="muted">
              未登録語があれば、対象を明示して計算を止めます。
            </span>
            <button className="button primary" disabled={busy}>
              距離を比較 <ArrowRight size={15} />
            </button>
          </div>
          <ErrorBox error={error} />
          {busy && <Pending />}
        </form>
      </Panel>
      {result && (
        <>
          <Panel
            title="距離行列"
            action={<Exports kind="distance" payload={result.settings} />}
          >
            <div className="padded">
              <label className="field">
                <span>距離の定義</span>
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                >
                  {Object.entries(metrics).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="table-scroll">
              <table className="matrix">
                <thead>
                  <tr>
                    <th>{metrics[metric]}</th>
                    {result.words.map((w: string, i: number) => (
                      <th key={i}>
                        <button className="word-link" onClick={() => select(w)}>
                          {w}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.matrices[metric].map((row: number[], i: number) => (
                    <tr key={i}>
                      <th>{result.words[i]}</th>
                      {row.map((v, j) => (
                        <td
                          key={j}
                          style={{
                            background: `rgba(77, 137, 107, ${metric === "cosine_similarity" ? (v + 1) * 0.22 : Math.max(0.03, 0.35 - v * 0.2)})`,
                          }}
                        >
                          {v.toFixed(4)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="notice">{result.warning}</div>
          </Panel>
          <Panel title="距離の読み方">
            <div className="help-copy">
              <p>
                コサイン類似度は向きの近さ（−1〜1）、コサイン距離は 1 −
                類似度、角距離は arccos(類似度) / π（0〜1）です。
              </p>
              <p>
                ユークリッド距離は成分の差のL2ノルムです。L2正規化するとベクトルの長さの影響を除いて比較できます。
              </p>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

export function Vectors() {
  const context = useContext(),
    { selectedWord, select, experiment, setExperiment, modelId } =
      useWorkspace();
  const [word, setWord] = useState(selectedWord || "猫"),
    [activeWord, setActiveWord] = useState(selectedWord || "猫"),
    [page, setPage] = useState(0);
  const [operation, setOperation] = useState("set_component"),
    [dimension, setDimension] = useState(0),
    [value, setValue] = useState(0.5),
    [fromWord, setFromWord] = useState("猫"),
    [toWord, setToWord] = useState("犬"),
    [deltaText, setDeltaText] = useState("");
  const [preview, setPreview] = useState<any>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (selectedWord) {
      setWord(selectedWord);
      setActiveWord(selectedWord);
      setPage(0);
    }
  }, [selectedWord]);
  useEffect(() => {
    select(activeWord);
  }, [activeWord, select]);
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [
    context,
    activeWord,
    operation,
    dimension,
    value,
    fromWord,
    toWord,
    deltaText,
  ]);
  const detail = useQuery({
    queryKey: ["word", context, activeWord, page],
    queryFn: () =>
      api("/words/inspect", {
        ...clean(context),
        word: activeWord,
        offset: page * 100,
        limit: 100,
      }),
    enabled: !!activeWord,
  });
  const neighbors = useQuery({
    queryKey: ["neighbors", context, activeWord],
    queryFn: () =>
      api("/similarity/rank", {
        ...clean(context),
        positive: [activeWord],
        top_n: 10,
      }),
    enabled: !!activeWord,
  });
  const all = useQuery({
    queryKey: ["all-components", context, activeWord],
    queryFn: () =>
      api("/words/inspect", {
        ...clean(context),
        word: activeWord,
        limit: 1000,
      }),
    enabled: !!activeWord,
  });
  const operate = async (confirm: boolean) => {
    if (!experiment) return;
    setError(null);
    setBusy(true);
    let op: any = { op: operation, dimension, value };
    if (operation === "normalize") op = { op: operation };
    if (operation === "add_difference")
      op = deltaText.trim()
        ? {
            op: operation,
            vector: deltaText
              .split(/[\s,、]+/)
              .filter(Boolean)
              .map(Number),
          }
        : { op: operation, from_word: fromWord, to_word: toWord };
    try {
      const response = await api(
        `/experiments/${experiment.id}/words/${encodeURIComponent(activeWord)}`,
        {
          expected_revision: experiment.revision,
          operations: [op],
          preview: !confirm,
        },
        "PATCH",
      );
      if (confirm) {
        setExperiment(response);
        setPreview(null);
      } else setPreview(response);
    } catch (e) {
      setError(e);
      if ((e as any).code === "REVISION_CONFLICT")
        setExperiment(await api(`/experiments/${experiment.id}`));
    } finally {
      setBusy(false);
    }
  };
  const startExperiment = async () => {
    try {
      setExperiment(await api("/experiments", { model_id: modelId }));
    } catch (e) {
      setError(e);
    }
  };
  const reset = async () => {
    try {
      if (experiment)
        setExperiment(
          await api(
            `/experiments/${experiment.id}/words/${encodeURIComponent(activeWord)}?expected_revision=${experiment.revision}`,
            undefined,
            "DELETE",
          ),
        );
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <Title
        eyebrow="INSIDE A WORD"
        title="言葉を、ひらいてみる。"
        description="ベクトルの全成分と統計を確認し、実験セッションの中で編集します。"
      />
      <Panel title="単語パラメータ">
        <form
          className="padded inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setActiveWord(word.trim());
            select(word.trim());
            setPage(0);
          }}
        >
          <WordInput label="観察する言葉" value={word} onChange={setWord} />
          <button className="button primary">
            <Eye size={16} />
            表示する
          </button>
        </form>
        <ErrorBox error={detail.error} />
        {detail.isLoading && <Pending />}
        {detail.data && (
          <>
            <div className="word-heading">
              <strong>{detail.data.word}</strong>
              <span className="tag neutral">INDEX {detail.data.index}</span>
              <span className="tag neutral">{detail.data.dimension} DIM</span>
              <span className="muted">頻度 {detail.data.count ?? "不明"}</span>
              {detail.data.edited && (
                <span className="tag">実験で編集済み</span>
              )}
              <Exports kind="vector" payload={{ word: activeWord }} />
            </div>
            <Stats stats={detail.data.statistics} />
            <div className="two-columns charts">
              <Suspense fallback={<Pending />}>
                <Plot
                  data={[
                    {
                      x: all.data?.components.map((c: any) => c.dimension),
                      y: all.data?.components.map((c: any) => c.value),
                      type: "scatter",
                      mode: "lines+markers",
                      line: { color: "#50896e", width: 2 },
                      marker: { size: 4 },
                    },
                  ]}
                  layout={{
                    ...plotLayout,
                    xaxis: { title: { text: "次元" } },
                    yaxis: { title: { text: "成分値" } },
                  }}
                  config={{ displayModeBar: false, responsive: true }}
                  useResizeHandler
                  style={{ width: "100%" }}
                />
                <Plot
                  data={[
                    {
                      x: all.data?.components.map((c: any) => c.value),
                      type: "histogram",
                      marker: { color: "#91b7a0" },
                      nbinsx: 15,
                    },
                  ]}
                  layout={{
                    ...plotLayout,
                    xaxis: { title: { text: "成分値の分布" } },
                    yaxis: { title: { text: "件数" } },
                  }}
                  config={{ displayModeBar: false, responsive: true }}
                  useResizeHandler
                  style={{ width: "100%" }}
                />
              </Suspense>
            </div>
            <div className="notice">
              次元番号には固有の意味はありません。図は先頭1000次元、表とエクスポートは全次元に対応します。
            </div>
            <div className="extreme-components">
              {all.data &&
                ["正方向", "負方向"].map((label, i) => (
                  <div key={label}>
                    <span>{label}の大きい成分</span>
                    <code>
                      {[...all.data.components]
                        .sort((a: any, b: any) =>
                          i ? a.value - b.value : b.value - a.value,
                        )
                        .slice(0, 3)
                        .map(
                          (c: any) => `d${c.dimension}: ${c.value.toFixed(4)}`,
                        )
                        .join(" · ")}
                    </code>
                  </div>
                ))}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>次元</th>
                    <th>基底値</th>
                    <th>現在値</th>
                    <th>差分 Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.components.map((c: any) => (
                    <tr key={c.dimension}>
                      <td>{c.dimension}</td>
                      <td>{c.base.toFixed(6)}</td>
                      <td>{c.value.toFixed(6)}</td>
                      <td className={c.delta ? "changed" : "muted"}>
                        {c.delta.toFixed(6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                前の100次元
              </button>
              <span>
                {page * 100 + 1}–
                {Math.min((page + 1) * 100, detail.data.dimension)} /{" "}
                {detail.data.dimension}
              </span>
              <button
                disabled={(page + 1) * 100 >= detail.data.dimension}
                onClick={() => setPage(page + 1)}
              >
                次の100次元
              </button>
            </div>
          </>
        )}
      </Panel>
      <Panel
        title="実験的なベクトル編集"
        subtitle="変更は実験セッションに隔離されます。基底モデルは変更しません。"
        action={<FlaskConical size={18} />}
      >
        <div className="padded">
          {!experiment ? (
            <button className="button primary" onClick={startExperiment}>
              <Plus size={16} />
              実験セッションを作る
            </button>
          ) : (
            <>
              <div className="advanced-grid">
                <label className="field">
                  <span>編集操作</span>
                  <select
                    value={operation}
                    onChange={(e) => setOperation(e.target.value)}
                  >
                    <option value="set_component">指定次元の値を設定</option>
                    <option value="add_component">指定次元に加算</option>
                    <option value="scale">全体をスカラー倍</option>
                    <option value="normalize">L2正規化</option>
                    <option value="add_difference">ベクトル差分を加算</option>
                  </select>
                </label>
                {operation.includes("component") && (
                  <label className="field">
                    <span>次元番号（0から）</span>
                    <input
                      type="number"
                      min={0}
                      max={(detail.data?.dimension || 1) - 1}
                      value={dimension}
                      onChange={(e) => setDimension(Number(e.target.value))}
                    />
                  </label>
                )}
                {!["normalize", "add_difference"].includes(operation) && (
                  <label className="field">
                    <span>値</span>
                    <input
                      type="number"
                      step="any"
                      value={value}
                      onChange={(e) => setValue(Number(e.target.value))}
                    />
                  </label>
                )}
                {operation === "add_difference" && (
                  <>
                    <WordInput
                      label="差分の基準語"
                      value={fromWord}
                      onChange={setFromWord}
                    />
                    <WordInput
                      label="差分の目標語"
                      value={toWord}
                      onChange={setToWord}
                    />
                    <label className="field">
                      <span>任意の差分ベクトル（入力時はこちらを使用）</span>
                      <input
                        value={deltaText}
                        onChange={(e) => setDeltaText(e.target.value)}
                        placeholder="0, 0.1, …"
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="form-actions">
                <button
                  className="button"
                  disabled={busy || !detail.data}
                  onClick={() => operate(false)}
                >
                  <Eye size={15} />
                  変更をプレビュー
                </button>
                <button className="text-button" onClick={reset}>
                  <RotateCcw size={14} />
                  この語をリセット
                </button>
              </div>
              {preview && (
                <div className="preview">
                  <h3>変更プレビュー</h3>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>次元</th>
                          <th>変更前</th>
                          <th>変更後</th>
                          <th>変化量</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.after.map(
                          (v: number, i: number) =>
                            preview.delta[i] !== 0 && (
                              <tr key={i}>
                                <td>{i}</td>
                                <td>{preview.before[i].toFixed(5)}</td>
                                <td>{v.toFixed(5)}</td>
                                <td>{preview.delta[i].toFixed(5)}</td>
                              </tr>
                            ),
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="form-actions">
                    <span className="muted">
                      revision {preview.revision} → {preview.revision + 1}
                    </span>
                    <button
                      className="button primary"
                      onClick={() => operate(true)}
                      disabled={busy}
                    >
                      <Check size={15} />
                      この変更を確定
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          <ErrorBox error={error} />
        </div>
      </Panel>
      {neighbors.data && (
        <Panel title="この言葉の近傍">
          <Ranking rows={neighbors.data.ranking} />
        </Panel>
      )}
    </>
  );
}
