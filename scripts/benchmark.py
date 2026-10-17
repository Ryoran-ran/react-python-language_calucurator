"""Small-fixture latency check. Run from the repository root; never downloads models."""

import json
import platform
import statistics
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import create_app

results = {}
with tempfile.TemporaryDirectory() as directory, TestClient(create_app(Path(directory))) as client:
    model = client.get("/api/v1/models").json()["models"][0]
    for name, method, url, body in [
        ("health", "get", "/api/v1/health", None),
        ("suggest", "get", "/api/v1/vocabulary/suggest?q=猫", None),
        ("inspect", "post", "/api/v1/words/inspect", {"word": "猫"}),
        ("cached_rank_20", "post", "/api/v1/similarity/rank", {"positive": ["猫"], "top_n": 20}),
    ]:
        timings = []
        for _ in range(31):
            start = time.perf_counter()
            response = client.get(url) if method == "get" else client.post(url, json=body)
            response.raise_for_status()
            timings.append((time.perf_counter() - start) * 1000)
        timings = sorted(timings[1:])
        results[name] = dict(p50_ms=round(statistics.median(timings), 3), p95_ms=round(timings[28], 3))
record = dict(
    system=platform.platform(),
    cpu=platform.processor(),
    python=platform.python_version(),
    model_sha256=model["sha256"],
    vocabulary_size=model["vocabulary_size"],
    dimensions=model["dimension"],
    mode="exact",
    source="project-original synthetic fixture; no real model benchmark",
    measurements=results,
)
target = Path("docs/benchmark.json")
target.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(record, ensure_ascii=False, indent=2))
