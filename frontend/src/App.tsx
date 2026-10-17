import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Box,
  Calculator,
  ChartNoAxesCombined,
  ChevronRight,
  Database,
  FlaskConical,
  GitBranch,
  HelpCircle,
  Leaf,
  Menu,
  Plus,
  RotateCcw,
  Search as SearchIcon,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api, download } from "./api";
import type { Model } from "./api";
import { ErrorBox, Panel, Pending, SafeLink, Stats, Title } from "./components";
import { useWorkspace } from "./store";
import Search from "./Search";
import { Arithmetic, Distances, Similarity, Vectors } from "./Analysis";

const Projection = lazy(() => import("./Projection")),
  Models = lazy(() => import("./Models"));
const nav = [
  ["/search", GitBranch, "連想探索", "01"],
  ["/arithmetic", Calculator, "ベクトル演算", "02"],
  ["/vectors", SlidersHorizontal, "単語パラメータ", "03"],
  ["/similarity", SearchIcon, "近い・遠い言葉", "04"],
  ["/distances", ChartNoAxesCombined, "距離比較", "05"],
  ["/projection", Box, "2D / 3D 可視化", "06"],
  ["/models", Database, "モデル管理", "07"],
] as const;
function Inspector({ close }: { close: () => void }) {
  const {
      selectedWord,
      selectedNode,
      selectedSearchId,
      modelId,
      experiment,
      setExperiment,
    } = useWorkspace(),
    navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const detail = useQuery({
    queryKey: [
      "inspector",
      modelId,
      experiment?.id,
      experiment?.revision,
      selectedWord,
      selectedSearchId,
    ],
    queryFn: () =>
      api(
        selectedSearchId
          ? `/searches/${selectedSearchId}/words/inspect`
          : "/words/inspect",
        {
          model_id: modelId,
          experiment_id: experiment?.id,
          word: selectedWord,
          limit: 100,
        },
      ),
    enabled: !!selectedWord,
  });
  const stats = detail.data?.statistics;
  const create = async () => {
    try {
      setExperiment(await api("/experiments", { model_id: modelId }));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <span>WORD INSPECTOR</span>
        <button
          className="icon-button close-inspector"
          aria-label="インスペクターを閉じる"
          onClick={close}
        >
          <X size={17} />
        </button>
        <SlidersHorizontal size={15} />
      </div>
      {selectedWord ? (
        <>
          <div className="inspected-word">
            <span>選択中の言葉</span>
            <h2>{selectedWord}</h2>
            <span className="tag neutral">
              {detail.data?.dimension || "…"} DIMENSIONS
            </span>
          </div>
          <ErrorBox error={detail.error} />
          {stats && (
            <>
              <div className="inspector-section">
                <h3>ベクトル統計</h3>
                <Stats stats={stats} />
              </div>
              <div
                className="mini-bars"
                role="img"
                aria-label="先頭32成分の概観"
              >
                {detail.data.components.slice(0, 32).map((c: any) => (
                  <i
                    key={c.dimension}
                    className={c.value < 0 ? "negative" : ""}
                    style={{
                      height:
                        Math.min(100, Math.max(3, Math.abs(c.value) * 70)) +
                        "%",
                    }}
                  />
                ))}
              </div>
              <p className="mini-caption">
                成分の概観 · 次元に固有の意味はありません
              </p>
              <button
                className="button inspect-button"
                onClick={() => navigate("/vectors")}
              >
                全成分と編集を見る <ArrowRight size={14} />
              </button>
            </>
          )}
        </>
      ) : (
        <div className="empty">単語を選ぶと、ここに詳細が表示されます。</div>
      )}
      {selectedWord && (
        <div className="word-shortcuts">
          <button
            className="text-button"
            onClick={() =>
              navigate("/search?start=" + encodeURIComponent(selectedWord))
            }
          >
            探索の出発に <ArrowRight size={12} />
          </button>
          <button
            className="text-button"
            onClick={() =>
              navigate("/search?goal=" + encodeURIComponent(selectedWord))
            }
          >
            探索の目標に <ArrowRight size={12} />
          </button>
          <button
            className="text-button"
            onClick={() =>
              navigate(
                "/distances?words=" +
                  encodeURIComponent(
                    selectedWord + "、" + (selectedWord === "猫" ? "犬" : "猫"),
                  ),
              )
            }
          >
            距離を比較 <ArrowRight size={12} />
          </button>
        </div>
      )}
      {selectedNode && (
        <div className="inspector-section">
          <h3>選択時点の探索スコア</h3>
          <dl className="metadata">
            <dt>g / h / f</dt>
            <dd>
              {selectedNode.g.toFixed(4)} / {selectedNode.h.toFixed(4)} /{" "}
              {selectedNode.f.toFixed(4)}
            </dd>
            <dt>親 / 深さ</dt>
            <dd>
              {selectedNode.parent || "なし"} / {selectedNode.depth}
            </dd>
            <dt>発見 / 展開</dt>
            <dd>
              {selectedNode.discovered_sequence} /{" "}
              {selectedNode.expanded_sequence || "未展開"}
            </dd>
            <dt>状態</dt>
            <dd>{selectedNode.state}</dd>
          </dl>
        </div>
      )}
      <div className="inspector-section experiment-card">
        <div className="inspector-section-title">
          <FlaskConical size={17} />
          <h3>実験セッション</h3>
        </div>
        {experiment ? (
          <>
            <div className="session-label">
              <span className="status-dot" />
              実験中 <code>REV {experiment.revision}</code>
            </div>
            <p>
              編集済み {Object.keys(experiment.edits).length}語<br />
              このセッションの計算に反映されます。
            </p>
            <button
              className="button small"
              onClick={async () => {
                try {
                  await download(
                    {
                      kind: "experiment",
                      format: "json",
                      model_id: modelId,
                      experiment_id: experiment.id,
                    },
                    "kotoba-patch.json",
                  );
                } catch (e) {
                  setError(e);
                }
              }}
            >
              <ArrowDownToLine size={13} />
              差分を保存
            </button>
            <label className="button small import-patch">
              差分を取り込む
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  try {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const patch = JSON.parse(await file.text());
                    setExperiment(
                      await api(`/experiments/${experiment.id}/import`, {
                        expected_revision: experiment.revision,
                        model_sha256: patch.model_sha256,
                        edits: patch.edits,
                      }),
                    );
                  } catch (err) {
                    setError(err);
                  }
                }}
              />
            </label>
            <button
              className="text-button reset-session"
              onClick={async () => {
                try {
                  await api(
                    `/experiments/${experiment.id}`,
                    undefined,
                    "DELETE",
                  );
                  setExperiment(null);
                } catch (e) {
                  setError(e);
                }
              }}
            >
              <RotateCcw size={13} />
              実験を破棄して基底に戻す
            </button>
          </>
        ) : (
          <>
            <p>ベクトルを編集して、つながりの変化を観察できます。</p>
            <button className="button small" onClick={create}>
              <Plus size={13} />
              新しい実験
            </button>
          </>
        )}
        <ErrorBox error={error} />
      </div>
      <div className="inspector-tip">
        <Leaf size={19} />
        <h3>言葉は、ひとつの意味ではない。</h3>
        <p>
          類似度には話題、文体、頻度なども反映されます。結果を観察しながら、モデルの癖を見つけましょう。
        </p>
        <button className="text-button" onClick={() => navigate("/help")}>
          実験の手引き <ChevronRight size={13} />
        </button>
      </div>
    </aside>
  );
}
function Help() {
  return (
    <>
      <Title
        eyebrow="A NOTE BEFORE EXPLORING"
        title="実験の手引き"
        description="結果を楽しむために、できることと解釈の限界を確認しましょう。"
      />
      <Panel title="Word2Vecが表すもの">
        <div className="help-copy">
          <p>
            Word2Vecはコーパスの共起傾向から学ぶ分布表現です。辞書的な意味、真偽、因果、人間の思考や連想そのものを表すものではありません。
          </p>
          <p>
            類似する言葉には同義語だけでなく、対義語、同じ話題、文体、固有名詞が含まれます。頻度、分かち書き、表記、学習条件によって結果は変わります。
          </p>
          <p>
            コーパスの偏り、差別表現、古い情報や誤記も反映されます。人物評価、採用、与信、医療、法的判断などには使わないでください。
          </p>
        </div>
      </Panel>
      <Panel title="A*探索の保証範囲">
        <div className="help-copy">
          <p>
            各語から上位k語へ向けて辺を張る有向グラフで探索します。コストは λ +
            (1−λ) × 角距離、ヒューリスティックは (1−λ) × 目標までの角距離です。
          </p>
          <p>
            モデル、実験revision、近傍数、フィルターが固定され、打ち切らずに目標を取り出した成功結果だけが、その固定グラフ内で最小コストになります。上位kの外の経路や、人間にとって自然な連想は保証しません。
          </p>
          <p>
            段階的拡張では k=10,25,50,100
            を独立に探索します。失敗は、その条件のグラフでの結果です。目標語を近傍へ強制追加しません。
          </p>
          <p>
            タイムラインの巻き戻しは表示だけを変更します。バックエンドの探索状態を戻したり、過去から再開したりする操作ではありません。
          </p>
        </div>
      </Panel>
      <Panel title="ベクトル、編集、射影">
        <div className="help-copy">
          <p>
            演算は線形な規則性の実験であり、一貫した意味結果を保証しません。各次元は回転可能で、次元番号に安定した意味を割り当てられません。別モデルの成分を座標ごとに直接比較できません。
          </p>
          <p>
            編集は60分間未使用で失効するメモリ内セッションです。基底モデルは不変です。ジョブは開始時点の編集を保持し、後から変更しても影響しません。
          </p>
          <p>
            2D/3Dは情報を失い、距離・近傍関係が歪みます。t-SNEの軸やクラスタ間距離を意味として読まず、別々の集合で計算した座標を比較しないでください。
          </p>
        </div>
      </Panel>
      <Panel title="モデルと権利情報">
        <div className="help-copy">
          <p>
            内蔵モデルはこのプロジェクト向けの人工ベクトル（CC0-1.0）です。学習済み日本語モデルではありません。モデル本体やコーパスを自動取得しません。
          </p>
          <p>
            持ち込みモデルはローカル処理し、出典・作成者・ライセンス・再配布可否を記録します。不明な権利情報は推測せずUNKNOWNとして扱います。エクスポートにモデル本体は含めません。
          </p>
          <SafeLink href="https://creativecommons.org/publicdomain/zero/1.0/">
            人工fixtureのCC0ライセンス
          </SafeLink>
        </div>
      </Panel>
    </>
  );
}
export default function App() {
  const { modelId, modelSelectionMade, setModel, experiment } = useWorkspace(),
    [menu, setMenu] = useState(false),
    [drawer, setDrawer] = useState(false);
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      api<{ models: Model[]; default_model_id: string }>("/models"),
  });
  useEffect(() => {
    if (!models.data) return;
    const loaded = models.data.models.filter((m) => m.state === "loaded");
    const defaultModel = loaded.find(
      (m) => m.id === models.data.default_model_id,
    );
    const currentLoaded = loaded.some((m) => m.id === modelId);
    const nextModel = defaultModel ?? loaded[0];
    if (
      nextModel &&
      (!modelSelectionMade || !currentLoaded) &&
      modelId !== nextModel.id
    )
      setModel(nextModel.id);
  }, [models.data, modelId, modelSelectionMade, setModel]);
  const current = models.data?.models.find((m) => m.id === modelId);
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (menu ? "mobile-open" : "")}>
        <NavLink className="brand" to="/search">
          <div className="brand-mark">
            <FlaskConical size={26} />
          </div>
          <div>
            <strong>言葉の実験室</strong>
            <span>KOTOBA LAB</span>
          </div>
        </NavLink>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(([path, Icon, label, number]) => (
            <NavLink
              key={path}
              to={path}
              onClick={() => setMenu(false)}
              className={({ isActive }) =>
                isActive ? "nav-item active" : "nav-item"
              }
            >
              <Icon size={18} />
              <span>{label}</span>
              <small>{number}</small>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="tiny-cross">✳</span>
          <h3>
            言葉のつながりに、
            <br />
            好奇心を。
          </h3>
          <p>
            見えなかった関係を
            <br />
            少しずつ、ひもとく。
          </p>
        </div>
        <div className="sidebar-bottom">
          <NavLink to="/help" className="nav-item">
            <HelpCircle size={17} />
            <span>実験の手引き</span>
            <BookOpen size={13} />
          </NavLink>
          <span className="local-label">
            <i /> LOCAL WORKSPACE <small>v0.1</small>
          </span>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="メニュー"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            ワークスペース <ChevronRight size={13} />
            <strong>言葉の実験室</strong>
          </div>
          <div className="topbar-right">
            <span className="model-ready">
              <i />
              {current?.state === "loaded" ? "モデル準備完了" : "接続を確認中"}
            </span>
            <span className="top-divider" />
            <Database size={15} />
            <select
              aria-label="使用するモデル"
              value={modelId}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.data?.models
                .filter((m) => m.state === "loaded")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
            </select>
            <span className="experiment-indicator">
              <FlaskConical size={15} />
              {experiment ? `実験 REV ${experiment.revision}` : "基底モデル"}
            </span>
            <button
              className="icon-button inspector-toggle"
              aria-label="単語の詳細を開く"
              onClick={() => setDrawer(!drawer)}
            >
              <SlidersHorizontal size={18} />
            </button>
          </div>
        </header>
        <div className="workspace-body">
          <main>
            <ErrorBox error={models.error} />
            <Suspense fallback={<Pending />}>
              <Routes>
                <Route path="/search" element={<Search />} />
                <Route path="/arithmetic" element={<Arithmetic />} />
                <Route path="/vectors" element={<Vectors />} />
                <Route path="/similarity" element={<Similarity />} />
                <Route path="/distances" element={<Distances />} />
                <Route path="/projection" element={<Projection />} />
                <Route path="/models" element={<Models />} />
                <Route path="/help" element={<Help />} />
                <Route path="*" element={<Search />} />
              </Routes>
            </Suspense>
            <footer className="main-footer">
              <FlaskConical size={13} />
              <span>言葉の実験室</span>
              <span>小さな発見から、言葉の世界を広げよう。</span>
            </footer>
          </main>
          <div
            className={"inspector-container " + (drawer ? "drawer-open" : "")}
          >
            <Inspector close={() => setDrawer(false)} />
          </div>
        </div>
      </div>
    </div>
  );
}
