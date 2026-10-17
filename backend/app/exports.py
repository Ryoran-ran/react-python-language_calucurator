from __future__ import annotations

import csv
import io
import json
import zipfile

from .core import LabError


def csv_bytes(rows: list[dict], bom: bool = True, safe: bool = True) -> bytes:
    output = io.StringIO(newline="")
    keys = list(dict.fromkeys(key for row in rows for key in row))
    writer = csv.DictWriter(output, fieldnames=keys)
    writer.writeheader()
    for row in rows:
        values = {}
        for key, value in row.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False, allow_nan=False)
            if safe and isinstance(value, str) and value.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")):
                value = "'" + value
            values[key] = value
        writer.writerow(values)
    return output.getvalue().encode("utf-8-sig" if bom else "utf-8")


def export_result(
    kind: str,
    fmt: str,
    payload: dict,
    bom: bool,
    safe: bool,
    nodes: list | None = None,
    edges: list | None = None,
    events: list | None = None,
) -> tuple[bytes, str, str]:
    if fmt == "json":
        return (
            json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2).encode(),
            "application/json",
            ".json",
        )
    if kind == "search":
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as z:
            for name, table_rows in {
                "nodes": nodes or [],
                "edges": edges or [],
                "path": [dict(step=i, word=w) for i, w in enumerate(payload.get("path", []))],
                "events": events or [],
            }.items():
                z.writestr(name + ".csv", csv_bytes(table_rows, bom, safe))
            z.writestr("metadata.json", json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2))
        return stream.getvalue(), "application/zip", ".zip"
    if fmt == "zip":
        raise LabError("INVALID_EXPORT", "ZIP形式は探索の出力に指定してください。")
    rows: list[dict] | None = next(
        (payload[key] for key in ("ranking", "pairs", "components", "points") if key in payload), None
    )
    if rows is None and kind == "experiment":
        rows = [
            dict(word=w, dimension=i, delta=v)
            for w, values in payload.get("edits", {}).items()
            for i, v in enumerate(values)
        ]
    if rows is None:
        raise LabError("INVALID_EXPORT", "出力できる表形式の結果がありません。")
    # Every CSV is self-describing, even when separated from the UI.
    metadata = {
        k: payload.get(k)
        for k in (
            "model_id",
            "model_sha256",
            "experiment_id",
            "experiment_revision",
            "license",
            "source_url",
            "app_version",
            "generated_at",
            "settings",
        )
    }
    return csv_bytes([dict(row, **metadata) for row in rows], bom, safe), "text/csv; charset=utf-8", ".csv"
