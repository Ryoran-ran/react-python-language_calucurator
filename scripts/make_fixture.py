"""Project-original synthetic vectors. CC0-1.0; no trained model or external corpus."""

import json
import math
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "fixtures"
root.mkdir(exist_ok=True)
words = "猫 犬 ペット 動物 生物 生命 自然 森 山 地球 世界 空 雲 風 光 太陽 星 月 夜 銀河 宇宙".split()
rows = []
for i, word in enumerate(words):
    angle = i * math.pi / 40
    rows.append((word, [math.cos(angle), math.sin(angle), 0.03 * math.sin(i), 0, 0, 0, 0, 0]))
rows += [
    ("日本", [0, 0, 0, 1, 0, 0, 0, 0]),
    ("東京", [0, 0, 0, 1, 1, 0, 0, 0]),
    ("中国", [0, 0, 0, 0, 0, 1, 0, 0]),
    ("北京", [0, 0, 0, 0, 1, 1, 0, 0]),
    ("フランス", [0, 0, 0, 0, 0, 0, 1, 0]),
    ("パリ", [0, 0, 0, 0, 1, 0, 1, 0]),
    ("王", [0, 0, 1, 0, 0, 0, 0, 1]),
    ("男", [0, 0, 1, 0, 0, 0, 0, 0]),
    ("女", [0, 0, 0, 0, 0, 0, 0, 1]),
    ("女王", [0, 0, 0, 0, 0, 0, 0, 2]),
    ("同点A", [-1, 0, 0, 0, 0, 0, 0, 0]),
    ("同点B", [-1, 0, 0, 0, 0, 0, 0, 0]),
    ("孤立", [0, -1, 0, 0, 0, 0, 0, 0]),
    ("ゼロ", [0] * 8),
    ("=安全確認", [0, 0, 0, 0, -1, 0, 0, 0]),
    ("a/b", [0, 0, 0, 0, 0, -1, 0, 0]),
]
(root / "tiny_vectors.txt").write_text(
    f"{len(rows)} 8\n" + "".join(w + " " + " ".join(f"{v:.9f}" for v in vs) + "\n" for w, vs in rows),
    encoding="utf-8",
)
(root / "metadata.json").write_text(
    json.dumps(
        {
            "display_name": "日本語デモ · 人工ベクトル",
            "creator": "言葉の実験室",
            "license_spdx": "CC0-1.0",
            "license_text_url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "source_url": None,
            "training_corpus": "なし。動作検証用に手作りした人工ベクトル。学習済みモデルではありません。",
            "redistribution_allowed": True,
            "language": "ja",
            "normalization_policy": "none",
            "tokenization": "手動定義",
            "training_parameters": {},
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)
