import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Database, FileUp, Upload } from "lucide-react";
import { api, ApiError } from "./api";
import type { Model } from "./api";
import { ErrorBox, Panel, Pending, SafeLink, Title } from "./components";
import { useWorkspace } from "./store";

export default function Models() {
  const { modelId, setModel } = useWorkspace(),
    client = useQueryClient();
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api<{ models: Model[] }>("/models"),
  });
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [file, setFile] = useState<File | null>(null);
  const [importId, setImportId] = useState<string | null>(null),
    [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!importId) return;
    const timer = setInterval(async () => {
      try {
        const job = await api(`/model-imports/${importId}`);
        setProgress(job.progress);
        if (job.status === "succeeded") {
          setBusy(false);
          setImportId(null);
          setFile(null);
          await client.invalidateQueries({ queryKey: ["models"] });
        } else if (job.error) {
          setBusy(false);
          setImportId(null);
          setError(new ApiError(job.error));
        }
      } catch (e) {
        setBusy(false);
        setImportId(null);
        setError(e);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [importId, client]);
  const [format, setFormat] = useState("word2vec_text"),
    [name, setName] = useState(""),
    [creator, setCreator] = useState(""),
    [source, setSource] = useState(""),
    [license, setLicense] = useState("UNKNOWN"),
    [corpus, setCorpus] = useState(""),
    [redistribution, setRedistribution] = useState("unknown");
  const action = async (id: string, op: string) => {
    setError(null);
    try {
      const response = await api(
        `/models/${id}${op === "delete" ? "" : "/" + op}${op === "load" ? "?background=true" : ""}`,
        undefined,
        op === "delete" ? "DELETE" : "POST",
      );
      if (op === "load") {
        setImportId(response.import_id);
        setBusy(true);
        return;
      }
      await client.invalidateQueries({ queryKey: ["models"] });
      if (op === "activate") setModel(id);
    } catch (e) {
      setError(e);
    }
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("format", format);
    form.set(
      "metadata",
      JSON.stringify({
        display_name: name || file.name,
        creator: creator || "不明",
        source_url: source || null,
        license_spdx: license || "UNKNOWN",
        training_corpus: corpus || "不明",
        redistribution_allowed:
          redistribution === "unknown" ? null : redistribution === "yes",
      }),
    );
    try {
      const response = await fetch("/api/v1/models?background=true", {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new ApiError(data);
      setImportId(data.import_id);
      setProgress(0);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="THE FOUNDATION"
        title="実験の土台を、選ぶ。"
        description="モデルの語彙、出典、ライセンスを確かめてから探索をはじめましょう。"
      />
      <ErrorBox error={models.error || error} />
      {models.isLoading && <Pending />}
      <Panel
        title="登録済みモデル"
        subtitle="データはこのコンピューター内で処理されます。"
        action={<Database size={18} />}
      >
        <div className="model-list">
          {models.data?.models.map((m) => (
            <article className="model-card" key={m.id}>
              <div className="model-card-title">
                <div className="model-icon">
                  <Database size={23} />
                </div>
                <div>
                  <h3>{m.display_name}</h3>
                  <span className="muted">{m.id}</span>
                </div>
                <span
                  className={"tag " + (m.state === "loaded" ? "" : "neutral")}
                >
                  {m.state === "loaded" ? "読み込み済み" : "未読み込み"}
                </span>
                {m.id === modelId && (
                  <span className="tag">
                    <Check size={12} />
                    使用中
                  </span>
                )}
              </div>
              <div className="model-numbers">
                <div>
                  <strong>{m.vocabulary_size.toLocaleString()}</strong>
                  <span>語彙</span>
                </div>
                <div>
                  <strong>{m.dimension}</strong>
                  <span>次元</span>
                </div>
                <div>
                  <strong>
                    {(m.estimated_memory_bytes / 1024 ** 2).toFixed(2)} MB
                  </strong>
                  <span>推定メモリ</span>
                </div>
                <div>
                  <strong>{m.license_spdx}</strong>
                  <span>ライセンス</span>
                </div>
              </div>
              <dl className="metadata">
                <dt>作成者</dt>
                <dd>{m.creator}</dd>
                <dt>出典</dt>
                <dd>
                  <SafeLink href={m.source_url}>
                    {m.source_url || "外部出典なし"}
                  </SafeLink>
                </dd>
                <dt>コーパス</dt>
                <dd>{m.training_corpus}</dd>
                <dt>学習条件</dt>
                <dd>
                  <code>
                    {Object.keys(m.training_parameters || {}).length
                      ? JSON.stringify(m.training_parameters)
                      : "記録なし"}
                  </code>
                </dd>
                <dt>再配布</dt>
                <dd>
                  {m.redistribution_allowed === true
                    ? "許可あり"
                    : m.redistribution_allowed === false
                      ? "許可なし"
                      : "不明（配布に同梱しない）"}
                </dd>
                <dt>正規化</dt>
                <dd>{m.normalization_policy}</dd>
                <dt>SHA-256</dt>
                <dd className="hash">{m.sha256}</dd>
                <dt>ファイル</dt>
                <dd>
                  {m.format} · {m.file_size_bytes.toLocaleString()} bytes
                </dd>
              </dl>
              <div className="form-actions">
                {m.state !== "loaded" && (
                  <button
                    className="button small"
                    onClick={() => action(m.id, "load")}
                  >
                    読み込む
                  </button>
                )}
                {m.state === "loaded" && (
                  <button
                    className="button small"
                    disabled={m.id === modelId}
                    onClick={() => action(m.id, "activate")}
                  >
                    既定モデルとして使う
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={
                    !!m.references || m.is_default || m.state !== "loaded"
                  }
                  onClick={() => action(m.id, "unload")}
                >
                  アンロード
                </button>
                {m.id !== "tiny-ja" && (
                  <button
                    className="text-button danger"
                    disabled={!!m.references || m.is_default}
                    onClick={() => action(m.id, "delete")}
                  >
                    このモデルを削除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </Panel>
      <Panel
        title="モデルを追加"
        subtitle="word2vec text / binary を検証して読み込みます。"
      >
        <form
          className="padded"
          onSubmit={(e) => {
            e.preventDefault();
            void upload();
          }}
        >
          <label className="upload-area">
            <FileUp size={28} />
            <strong>{file?.name || "モデルファイルを選択"}</strong>
            <span>word2vec text / binary · 最大64 MB（設定で変更可能）</span>
            <input
              type="file"
              accept=".txt,.vec,.bin"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
            />
          </label>
          <div className="two-columns">
            <label className="field">
              <span>表示名</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>ファイル形式</span>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="word2vec_text">word2vec text</option>
                <option value="word2vec_binary">word2vec binary</option>
              </select>
            </label>
            <label className="field">
              <span>作成者</span>
              <input
                value={creator}
                onChange={(e) => setCreator(e.target.value)}
              />
            </label>
            <label className="field">
              <span>出典URL</span>
              <input
                type="url"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <label className="field">
              <span>ライセンス（SPDX等）</span>
              <input
                value={license}
                onChange={(e) => setLicense(e.target.value)}
              />
            </label>
            <label className="field">
              <span>再配布の許可</span>
              <select
                value={redistribution}
                onChange={(e) => setRedistribution(e.target.value)}
              >
                <option value="unknown">不明</option>
                <option value="yes">許可を確認済み</option>
                <option value="no">再配布不可</option>
              </select>
            </label>
            <label className="field wide">
              <span>コーパス情報</span>
              <input
                value={corpus}
                onChange={(e) => setCorpus(e.target.value)}
              />
            </label>
          </div>
          {(!license || license === "UNKNOWN") && (
            <div className="notice">
              ライセンスが不明です。ローカルで検証できますが、配布成果物には同梱しないでください。
            </div>
          )}
          <div className="form-actions">
            <span className="muted">
              .kv / pickle / 圧縮ファイルは読み込みません。
            </span>
            <button className="button primary" disabled={!file || busy}>
              <Upload size={15} />
              {busy ? "検証・読み込み中…" : "検証して登録"}
            </button>
          </div>
          {busy && (
            <>
              <Pending />
              <div className="import-progress">
                <progress
                  aria-label="モデル検証の進捗"
                  max={1}
                  value={progress}
                />
                <span>{Math.round(progress * 100)}%</span>
                <button
                  type="button"
                  className="button small danger"
                  disabled={!importId}
                  onClick={() => {
                    if (importId)
                      void api(
                        `/model-imports/${importId}`,
                        undefined,
                        "DELETE",
                      );
                  }}
                >
                  読み込みをキャンセル
                </button>
              </div>
            </>
          )}
        </form>
      </Panel>
    </>
  );
}
