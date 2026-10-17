export type Model = {
  training_parameters: Record<string, unknown>;
  id: string;
  display_name: string;
  vocabulary_size: number;
  dimension: number;
  sha256: string;
  state: string;
  license_spdx: string;
  source_url: string | null;
  creator: string;
  training_corpus: string;
  redistribution_allowed: boolean | null;
  format: string;
  normalization_policy: string;
  estimated_memory_bytes: number;
  file_size_bytes: number;
  generation_id: string;
  is_default?: boolean;
  references: number;
};
export type Experiment = {
  id: string;
  model_id: string;
  model_sha256: string;
  revision: number;
  edits: Record<string, number[]>;
};
export type LabEvent = { sequence: number; type: string; [key: string]: any };
export type SearchNode = {
  word: string;
  g: number;
  h: number;
  f: number;
  parent: string | null;
  depth: number;
  state: string;
  discovered_sequence: number;
  expanded_sequence: number | null;
};
export type SearchEdge = {
  source: string;
  target: string;
  cost: number;
  cosine_similarity: number;
  angular_distance: number;
  selected: boolean;
};
export class ApiError extends Error {
  code: string;
  details: any;
  requestId: string;
  constructor(data: any) {
    super(data?.error?.message || "サーバーとの通信に失敗しました。");
    this.code = data?.error?.code || "NETWORK_ERROR";
    this.details = data?.error?.details || {};
    this.requestId = data?.error?.request_id || "";
  }
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(null);
  }
  if (!response.ok) throw new ApiError(await response.json().catch(() => null));
  return response.json();
}
export async function download(body: unknown, filename: string) {
  const response = await fetch("/api/v1/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(await response.json());
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
