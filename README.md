# 言葉の実験室 · Kotoba Lab

Word2Vecベクトルを、探索過程・数値・編集・射影から観察するローカルWebアプリです。
React / TypeScript / Vite と Python 3.12 / FastAPI / Gensim で実装しています。
元の仕様書は [docs/specification.md](docs/specification.md) に保存しています。

## この作業環境で起動する

必要な実行環境と依存は、このフォルダー内の `.runtime/` と `frontend/node_modules/` に用意しています。
フロントエンドをビルドした状態で、PowerShellから実行します。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

ブラウザで **http://127.0.0.1:8000/** を開きます。終了はターミナルで Ctrl+C。
開発用サーバーは `-Development` を付けると http://127.0.0.1:5173/ で起動します。
システムのPATHや既存Pythonは変更していません。`.runtime` は配布対象外です。

## 新しい環境でセットアップする

Python 3.12、Node.js 22.12以上（検証版22.23.0）を用意します。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock.txt
cd frontend
npm ci
npm run build
cd ..
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

macOS / Linuxでは `python3.12 -m venv .venv`、`.venv/bin/python -m pip install ...`、
`cd frontend && npm ci && npm run build` の後、リポジトリ直下で以下を実行します。

```sh
.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

API文書は http://127.0.0.1:8000/docs 。フロントエンドのルーティングはハッシュ方式です。
開発時はAPIを8000番、`cd frontend; npm run dev` を5173番で起動します。

## できること

- A*連想探索：固定有向top-kグラフ、角距離コスト、独立したprogressive widening。
- 探索イベントのSSE配信、連番による重複排除、切断後の復元。一時停止、再開、1展開ずつ実行、キャンセル。
- パン・ズームできる探索グラフ、キーボードから選べるノード表、表示時点を巻き戻せるタイムライン。
- 型付きASTによる加減算、スカラー乗除、括弧。フォームとテキスト入力。`eval` は使用しません。
- コサイン類似度による近い言葉・遠い言葉のランキング、5種類の距離行列、全ベクトル成分のページング表示、統計・折れ線・ヒストグラム。
- 基底モデルを変えない実験編集：成分設定・加算、全体スケール、L2正規化、ベクトル差分加算、リセット。
- 編集のプレビュー、revision競合検出、差分JSON保存・再適用、60分未使用での失効。
- PCA / t-SNE の2D・3D表示、回転・ズーム、座標表、再現パラメーター保存。別プロセス実行とキャンセル。
- 安全なword2vec text / binary登録、検証、読み込み、既定化、アンロード、削除。
- JSON、BOM付きCSV、探索のCSV群ZIP。ハッシュ・出典・ライセンス・設定・アプリ版を出力。

## 最初の実験

1. 内蔵の「日本語デモ · 人工ベクトル」で「猫 → 宇宙」を探索。
2. ノード一覧やグラフから語を選び、「全成分と編集を見る」を開く。
3. 実験を作成し、1成分をプレビューして変更。セッション内の計算だけに反映されます。
4. 演算画面で「東京 − 日本 ＋ 中国」を計算。人工モデルでは北京と一致します。
5. 結果を可視化・エクスポートし、実験を破棄して基底へ戻す。

内蔵データは37語×8次元の **プロジェクト独自の人工fixture** です。
CC0-1.0で、第三者モデルや学習コーパスは含みません。学習済みの日本語モデルではありません。
生成スクリプトは `scripts/make_fixture.py`。ゼロベクトルは検証用で、類似度・探索では拒否します。

## 持ち込みモデル

「モデル管理」でファイル形式、出典、作成者、ライセンス、再配布可否、コーパスを登録します。
word2vec textは先頭に `語彙数 次元数` が必要です。binaryはGensim互換のword2vec形式です。
圧縮、`.kv`、pickleは受け付けません。任意ローカルパスを読むAPIも公開しません。
未知の権利情報は `UNKNOWN` になり、配布には自動同梱しません。
登録ファイルとメタデータは `data/` に保存され、再起動後も一覧に残ります（組み込みモデル以外は再読み込みが必要）。
word2vecファイルには学習頻度がないため、頻度は「不明」です。Gensimが行順から作る仮のcountを頻度として表示しません。
既定モデルの選択は `data/default-model.json` に保存され、次回起動時に自動で読み込まれます。実験状態はプロセス内です。進行中のジョブは開始時のモデルとrevisionを保持します。

## 日本語Wikipediaからモデルを作る

`scripts/wikipedia_word2vec.py` は、公式Wikipedia XMLダンプを逐次読み込み、本文抽出、Sudachiによる分かち書き、Gensim Word2Vec学習、アプリ用binary出力まで行います。長時間処理なのでWebサーバーとは別のPowerShellで実行します。

まず学習専用の日本語辞書をインストールします。

```powershell
.\.runtime\python\python.exe -m pip install -r training-requirements.txt
```

ダンプを `data/wikipedia/jawiki-latest-pages-articles1.xml-p1p114794.bz2` に置いた場合、最初に1000記事だけで工程を確認できます。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\train_wikipedia.ps1 `
  -Stage all `
  -MaxArticles 1000 `
  -MaxVocabulary 20000 `
  -MinCount 5 `
  -Corpus .\data\wikipedia\pilot-corpus.txt.gz `
  -Output .\data\wikipedia\pilot-word2vec.bin
```

語彙を増やす場合は、元のモデルを残したまま10,000記事で学習できます。この構成では約3,517万トークンから95,219語のモデルを生成しました。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\train_wikipedia.ps1 `
  -Stage all `
  -MaxArticles 10000 `
  -MaxVocabulary 100000 `
  -MinCount 10 `
  -Epochs 5 `
  -Corpus .\data\wikipedia\wikipedia-10000-corpus.txt.gz `
  -Output .\data\wikipedia\wikipedia-10000-word2vec.bin
```

分割ダンプ全体を10万語・100次元で学習する本番コマンドです。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\train_wikipedia.ps1 -Stage all
```

完成した `data/wikipedia/jawiki-word2vec-100d.bin` を「モデル管理」で `word2vec binary` として登録します。本文抽出・学習中は進捗をPowerShellへ表示します。`Ctrl+C` で中断できますが、`.partial` は不完全な出力として残るため、最初からやり直す場合は `-Force` を指定します。

既定値はSudachi分割モードC、正規化形、skip-gram、window 5、min count 20、5 epochsです。元ダンプと生成物のSHA-256、記事・文・トークン数、学習条件は隣接する `*.metadata.json` に保存されます。Wikipedia本文の出典、取得日、ライセンス条件を確認し、生成モデルを外部配布するときは適切な帰属情報を添えてください。

## 設定と制限

`.env.example` を参考に環境変数を設定します。`.env` の自動読み込みは行いません。

| 環境変数 | 既定値 |
|---|---:|
| `LAB_DATA_DIR` | `./data` |
| `LAB_MAX_UPLOAD_MB` | 64 |
| `LAB_MAX_MEMORY_MB` | 256 |
| `LAB_MAX_LOADED_MODELS` | 3 |
| `LAB_MAX_JOBS` | 4 |
| `LAB_MAX_EVENTS` | 100000 |
| `LAB_MAX_EVENT_ARCHIVE_MB` | 64 |
| `LAB_EXPERIMENT_TTL_SECONDS` | 3600 |
| `LAB_JOB_TTL_SECONDS` | 86400 |

探索は最大100,000展開・300秒、式は深さ16・127ノード・スカラー絶対値100万以下、
距離比較は50語、射影は5000語（t-SNEは2000語）です。
検索結果は24時間、最大100ジョブまで保持します。探索グラフは5000ノードを上限に表示し、全イベントをエクスポートできます。
APIは127.0.0.1へバインドし、Host/Originを制限します。認証のない単一ユーザー用です。

## テスト

通常環境では `.venv` のPythonを使います。この作業環境では `.runtime/python/python.exe` を使えます。

```powershell
python -m pytest -q
python -m ruff check backend scripts
python -m mypy backend/app
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

PlaywrightはAPIとViteを自動起動します。`LAB_PYTHON` にPython実行ファイルを指定できます。
ポータブル環境では `PLAYWRIGHT_BROWSERS_PATH` を `.runtime/browsers` の絶対パスにします。
CI設定は `.github/workflows/ci.yml`。ここでの検証結果と未達条件は [docs/verification.md](docs/verification.md) を参照してください。
小型fixtureの計測は `python -m scripts.benchmark`、結果は `docs/benchmark.json` です。

## 解釈と既知の制約

Word2Vecは共起傾向であり、真偽、因果、人間の思考や公平性を保証しません。
類似度には対義語、話題、文体、頻度、コーパスの偏りも反映されます。
成分番号に固有の意味はなく、モデル間の座標は直接比較できません。
射影では距離や近傍が歪み、t-SNEの軸やクラスタ間距離を意味として解釈できません。
人物評価、採用、与信、医療、法的判断には使わないでください。

A*の最適性は、その実行で固定した有向top-kグラフ内の定義済みコストに限ります。
上限・タイムアウト・キャンセル時の経路は暫定で、成功として表示しません。
progressive wideningは各kで最初からやり直し、到達した段階のグラフ内だけを保証します。

- ANNとUMAPは有効化していません。exact / PCA / t-SNEを利用できます。
- プロジェクト独自のCC0コーパスからGensimで実際に学習した小型モデル（32次元）の主要フローをtext/binaryで検証済みです。`python -m scripts.validate_trained_model` で再現できます。第三者の事前学習モデルや大規模モデルでの性能・言語品質は未検証です。モデルの自動取得は行いません。
- 探索イベントはメモリ上限を超えると、状態スナップショットを作り、古い詳細をローカルの一時SQLiteへ退避します。APIの `archived_ranges` と `missing_ranges` で範囲を明示し、過去イベントも欠落なく再接続・出力できます。履歴総容量64MB、探索状態20,000語・100,000辺の上限では `RESOURCE_LIMIT` として保持済みデータを残します。
- UIからのモデル登録・再読み込みは非同期検証ジョブで、進捗とキャンセルに対応します。検証行・読み込み前後で協調キャンセルします。互換用の同期APIも残しています。
- UIの射影は最大2並列の別プロセスジョブです。キャンセル時は該当ワーカーだけを終了し、180秒上限を設けています。互換用の同期APIも残しています。
- 成分グラフは先頭1000次元、全成分は表と出力で確認できます。
- 実験・ジョブは再起動で消えます。差分は事前にJSON出力してください。
- Plotlyの表示コードは遅延読み込みですが約1.4MB gzipです。初回表示に時間がかかる場合があります。
- 検証・読み込みは同一プロセスです。メモリ上限は保守的な見積もりであり、OSの厳密なメモリ隔離ではありません。

5,000ノードの描画・パン・ズームと、10,000語×32次元のexact探索のキャンセルを検証しています。
環境と測定値は `docs/performance-5000.json` / `docs/performance-search.json`。
再現は `npm run test:e2e` と `python -m scripts.benchmark_search` です。

アプリ本体はMIT、人工fixtureはCC0-1.0です。Gensim等の依存ライセンスと持ち込みモデルのライセンスは別です。
