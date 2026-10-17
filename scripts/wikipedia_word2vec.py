"""Build a Japanese Word2Vec model from an official Wikipedia XML dump.

The pipeline is deliberately separate from the web server because extraction and
training can run for hours. It streams both the dump and the prepared corpus so
the whole dataset is never loaded into memory at once.
"""

from __future__ import annotations

import argparse
import bz2
import gzip
import hashlib
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from gensim.corpora.wikicorpus import filter_wiki
from gensim.models import Word2Vec
from gensim.models.word2vec import LineSentence

from backend.app.core import ROOT

DEFAULT_DUMP = ROOT / "data/wikipedia/jawiki-latest-pages-articles1.xml-p1p114794.bz2"
DEFAULT_CORPUS = ROOT / "data/wikipedia/jawiki-corpus.txt.gz"
DEFAULT_MODEL = ROOT / "data/wikipedia/jawiki-word2vec-100d.bin"
SOURCE_URL = "https://dumps.wikimedia.org/jawiki/latest/"
LICENSE_URL = "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use"
SENTENCE_BOUNDARY = re.compile(r"(?:[。！？!?]+|[\r\n]+)")
TOKEN_CONTENT = re.compile(r"[0-9A-Za-zぁ-んァ-ヶ一-龯々〆ヵヶ]", re.UNICODE)
EXCLUDED_POS = {"空白", "補助記号", "記号"}


def file_hash(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def stable_hash(word: str) -> int:
    return int.from_bytes(hashlib.sha256(word.encode("utf-8")).digest()[:4], "little")


def iter_articles(path: Path) -> Iterator[tuple[str, str]]:
    """Yield main-namespace, non-redirect articles without retaining the XML tree."""

    with bz2.open(path, "rb") as source:
        context = ET.iterparse(source, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            if event != "end" or not element.tag.endswith("}page"):
                continue
            namespace = element.findtext("./{*}ns")
            redirect = element.find("./{*}redirect")
            title = element.findtext("./{*}title") or ""
            text = element.findtext("./{*}revision/{*}text") or ""
            if namespace == "0" and redirect is None and text:
                yield title, text
            element.clear()
            root.clear()


def split_sentences(text: str, max_chars: int = 8_000) -> Iterator[str]:
    for sentence in SENTENCE_BOUNDARY.split(text):
        sentence = re.sub(r"\s+", " ", sentence).strip()
        if not sentence:
            continue
        for offset in range(0, len(sentence), max_chars):
            chunk = sentence[offset : offset + max_chars].strip()
            if chunk:
                yield chunk


def usable_token(value: str, part_of_speech: str) -> bool:
    return (
        bool(value)
        and len(value) <= 64
        and part_of_speech not in EXCLUDED_POS
        and bool(TOKEN_CONTENT.search(value))
        and not value.isspace()
    )


def load_sudachi(split_mode: str):
    try:
        from sudachipy import dictionary, tokenizer
    except ImportError as error:
        raise SystemExit(
            "SudachiPyが必要です。先に次を実行してください: "
            ".\\.runtime\\python\\python.exe -m pip install -r training-requirements.txt"
        ) from error
    analyzer = dictionary.Dictionary(dict="core").tokenizer()
    mode = getattr(tokenizer.Tokenizer.SplitMode, split_mode)
    return analyzer, mode


def tokenize_sentence(analyzer, mode, sentence: str, token_form: str) -> list[str]:
    result: list[str] = []
    for morpheme in analyzer.tokenize(sentence, mode):
        if token_form == "surface":
            value = morpheme.surface()
        elif token_form == "dictionary":
            value = morpheme.dictionary_form()
        else:
            value = morpheme.normalized_form()
        value = value.strip().replace(" ", "_")
        part_of_speech = morpheme.part_of_speech()[0]
        if usable_token(value, part_of_speech):
            result.append(value)
    return result


def prepare_corpus(args: argparse.Namespace) -> dict[str, Any]:
    source = args.input.resolve()
    target = args.corpus.resolve()
    if not source.is_file():
        raise SystemExit(f"Wikipediaダンプが見つかりません: {source}")
    if target.exists() and not args.force:
        print(f"既存の分かち書き済みコーパスを使用します: {target}", flush=True)
        metadata_path = target.with_name(target.name + ".metadata.json")
        return json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}

    analyzer, mode = load_sudachi(args.split_mode)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    if partial.exists():
        if not args.force:
            raise SystemExit(f"中断ファイルがあります。再実行には --force を指定してください: {partial}")
        partial.unlink()

    started = time.monotonic()
    article_count = sentence_count = token_count = 0
    opener = gzip.open if target.suffix == ".gz" else open
    with opener(partial, "wt", encoding="utf-8", newline="\n") as output:
        for title, raw_text in iter_articles(source):
            article_count += 1
            cleaned = filter_wiki(raw_text, promote_remaining=True, simplify_links=True)
            for sentence in split_sentences(cleaned):
                tokens = tokenize_sentence(analyzer, mode, sentence, args.token_form)
                if len(tokens) < 2:
                    continue
                output.write(" ".join(tokens) + "\n")
                sentence_count += 1
                token_count += len(tokens)
            if article_count % 1_000 == 0:
                elapsed = max(time.monotonic() - started, 0.001)
                print(
                    f"抽出: {article_count:,}記事 / {sentence_count:,}文 / "
                    f"{token_count:,}語 ({article_count / elapsed:.1f}記事/秒) · {title}",
                    flush=True,
                )
            if args.max_articles and article_count >= args.max_articles:
                break

    partial.replace(target)
    metadata = {
        "source_file": source.name,
        "source_sha256": file_hash(source),
        "source_url": SOURCE_URL,
        "license_information": LICENSE_URL,
        "articles": article_count,
        "sentences": sentence_count,
        "tokens": token_count,
        "split_mode": args.split_mode,
        "token_form": args.token_form,
        "max_articles": args.max_articles or None,
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }
    metadata_path = target.with_name(target.name + ".metadata.json")
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"分かち書き完了: {target}", flush=True)
    return metadata


def train_model(args: argparse.Namespace, corpus_metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    corpus = args.corpus.resolve()
    target = args.output.resolve()
    if not corpus.is_file():
        raise SystemExit(f"分かち書き済みコーパスが見つかりません: {corpus}")
    if target.exists() and not args.force:
        raise SystemExit(f"出力モデルは既に存在します。上書きには --force を指定してください: {target}")

    target.parent.mkdir(parents=True, exist_ok=True)
    workers = args.workers or min(max((os.cpu_count() or 2) - 1, 1), 4)
    started = time.monotonic()
    print(
        f"学習開始: {args.vector_size}次元 / 最大{args.max_vocab:,}語 / "
        f"min_count={args.min_count} / epochs={args.epochs} / workers={workers}",
        flush=True,
    )
    model = Word2Vec(
        sentences=LineSentence(str(corpus)),
        vector_size=args.vector_size,
        window=args.window,
        min_count=args.min_count,
        max_final_vocab=args.max_vocab,
        workers=workers,
        seed=args.seed,
        epochs=args.epochs,
        sg=1,
        negative=10,
        sample=1e-3,
        hashfxn=stable_hash,
    )
    partial = target.with_name(target.name + ".partial")
    if partial.exists():
        if not args.force:
            raise SystemExit(f"中断ファイルがあります。再実行には --force を指定してください: {partial}")
        partial.unlink()
    model.wv.save_word2vec_format(str(partial), binary=True)
    partial.replace(target)

    if corpus_metadata is None:
        corpus_metadata_path = corpus.with_name(corpus.name + ".metadata.json")
        corpus_metadata = (
            json.loads(corpus_metadata_path.read_text(encoding="utf-8"))
            if corpus_metadata_path.exists()
            else {}
        )
    metadata = {
        "display_name": f"日本語Wikipedia Word2Vec {args.vector_size}d",
        "format": "word2vec_binary",
        "model_sha256": file_hash(target),
        "vocabulary_size": len(model.wv),
        "dimensions": args.vector_size,
        "training": {
            "algorithm": "skip-gram with negative sampling",
            "window": args.window,
            "min_count": args.min_count,
            "max_final_vocab": args.max_vocab,
            "epochs": args.epochs,
            "negative": 10,
            "sample": 1e-3,
            "seed": args.seed,
            "workers": workers,
        },
        "corpus": corpus_metadata,
        "rights_note": (
            "Source text is from Japanese Wikipedia. Confirm attribution and model redistribution "
            "terms before sharing the generated vectors."
        ),
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }
    metadata_path = target.with_name(target.name + ".metadata.json")
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"学習完了: {target} ({len(model.wv):,}語 / {target.stat().st_size / 1024**2:.1f} MiB)",
        flush=True,
    )
    return metadata


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="日本語WikipediaからWord2Vecモデルを作成します。")
    result.add_argument("stage", choices=("prepare", "train", "all"), nargs="?", default="all")
    result.add_argument("--input", type=Path, default=DEFAULT_DUMP)
    result.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    result.add_argument("--output", type=Path, default=DEFAULT_MODEL)
    result.add_argument("--max-articles", type=int, default=0, help="0は全記事")
    result.add_argument("--split-mode", choices=("A", "B", "C"), default="C")
    result.add_argument("--token-form", choices=("surface", "dictionary", "normalized"), default="normalized")
    result.add_argument("--vector-size", type=int, default=100)
    result.add_argument("--max-vocab", type=int, default=100_000)
    result.add_argument("--min-count", type=int, default=20)
    result.add_argument("--window", type=int, default=5)
    result.add_argument("--epochs", type=int, default=5)
    result.add_argument("--workers", type=int, default=0, help="0は最大4で自動設定")
    result.add_argument("--seed", type=int, default=42)
    result.add_argument("--force", action="store_true")
    return result


def validate_args(args: argparse.Namespace) -> None:
    for name in ("max_articles", "workers"):
        if getattr(args, name) < 0:
            raise SystemExit(f"--{name.replace('_', '-')} は0以上にしてください。")
    for name in ("vector_size", "max_vocab", "min_count", "window", "epochs"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} は1以上にしてください。")


def main() -> None:
    args = parser().parse_args()
    validate_args(args)
    corpus_metadata: dict[str, Any] | None = None
    if args.stage in {"prepare", "all"}:
        corpus_metadata = prepare_corpus(args)
    if args.stage in {"train", "all"}:
        train_model(args, corpus_metadata)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n中断しました。完成済みの入力ファイルは削除していません。", file=sys.stderr)
        raise SystemExit(130) from None
