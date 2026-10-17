import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Download,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { api, ApiError, download } from "./api";
import { useWorkspace } from "./store";

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={17} />
      <div>
        <strong>{e.message || "処理に失敗しました。"}</strong>
        {e.details?.word && (
          <p>
            対象語：{e.details.word} · {e.details.model}
          </p>
        )}
        {e.details?.suggestions?.length > 0 && (
          <p>候補：{e.details.suggestions.join("、")}</p>
        )}
        <details>
          <summary>
            詳細 {e.code} {e.requestId}
          </summary>
          <pre>{JSON.stringify(e.details, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}
export function Pending() {
  return (
    <div className="pending" role="status">
      <LoaderCircle className="spin" size={18} /> 計算しています…
    </div>
  );
}
export function WordInput({
  label,
  value,
  onChange,
  placeholder = "単語を入力",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const id = useId(),
    modelId = useWorkspace((s) => s.modelId);
  const { data } = useQuery({
    queryKey: ["suggest", modelId, value],
    queryFn: () =>
      api<{ words: string[] }>(
        "/vocabulary/suggest?model_id=" +
          encodeURIComponent(modelId) +
          "&q=" +
          encodeURIComponent(value),
      ),
    staleTime: 60000,
  });
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={id}
        required={required}
        maxLength={512}
      />
      <datalist id={id}>
        {data?.words.map((w) => <option key={w} value={w} />)}
      </datalist>
    </label>
  );
}
export function Title({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  children,
  action,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Exports({
  kind,
  payload = {},
  searchId,
  projectionId,
}: {
  kind: string;
  payload?: any;
  searchId?: string;
  projectionId?: string;
}) {
  const { modelId, experiment } = useWorkspace(),
    [error, setError] = useState<unknown>(null);
  const run = async (format: string) => {
    try {
      setError(null);
      await download(
        {
          kind,
          format,
          model_id: modelId,
          experiment_id: experiment?.id,
          search_id: searchId,
          projection_id: projectionId,
          payload,
        },
        `kotoba-${kind}.${format}`,
      );
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div>
      <div className="export-buttons">
        <button className="button small" onClick={() => run("json")}>
          <Download size={14} />
          JSON
        </button>
        <button
          className="button small"
          onClick={() => run(kind === "search" ? "zip" : "csv")}
        >
          {kind === "search" ? "CSV / ZIP" : "CSV"}
        </button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
export function Stats({ stats }: { stats: any }) {
  return (
    <div className="stats-grid">
      {[
        ["L2 ノルム", "l2"],
        ["L1 ノルム", "l1"],
        ["平均", "mean"],
        ["標準偏差", "std"],
        ["最小", "min"],
        ["最大", "max"],
      ].map(([label, key]) => (
        <div key={key}>
          <span>{label}</span>
          <strong>{Number(stats[key]).toFixed(4)}</strong>
        </div>
      ))}
    </div>
  );
}
export function Ranking({
  rows,
  farthest = false,
}: {
  rows: any[];
  farthest?: boolean;
}) {
  const select = useWorkspace((s) => s.select);
  if (!rows.length)
    return <div className="empty">条件に一致する候補がありません。</div>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>単語</th>
            <th>コサイン類似度</th>
            <th>コサイン距離</th>
            <th>角距離</th>
            <th>頻度</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.word}>
              <td className="muted">{String(i + 1).padStart(2, "0")}</td>
              <td>
                <button className="word-link" onClick={() => select(row.word)}>
                  {row.word}
                </button>
              </td>
              <td>
                <div className="score-cell">
                  <span>{row.cosine_similarity.toFixed(5)}</span>
                  {!farthest && (
                    <div className="bar">
                      <i
                        style={{
                          width: `${Math.max(0, row.cosine_similarity) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </td>
              <td>{row.cosine_distance.toFixed(5)}</td>
              <td>{row.angular_distance.toFixed(5)}</td>
              <td>{row.count ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function SafeLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  return href && /^https?:\/\//.test(href) ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={12} />
    </a>
  ) : (
    <span>{children}</span>
  );
}
