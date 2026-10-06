# SoyokazeMemo

一時的な手書きメモ　コピペなどするときに

チャットにちょっと図を貼りたい、スクショに丸を付けて送りたい——そんなとき用の、**出力先がクリップボードだけ**の軽量ペイントアプリです。
ファイル保存機能は意図的に持たせていません。描いて `Ctrl+C`、チャットで `Ctrl+V`、それだけ。

- Windows 11 ネイティブアプリ（Tauri v2 / WebView2）
- インストーラー（`.exe` / `.msi`）を出力可能
- UI は OS のライト / ダークモードに自動追従、キャンバスは目に優しい下書き用紙グレー `#D9DCD6`

## インストール（使うだけの人向け）

1. [Releases](https://github.com/ThunFasky/SoyokazeMemo/releases/latest) から `SoyokazeMemo_x.y.z_x64-setup.exe` をダウンロード
2. ダブルクリックしてインストール（管理者権限は不要。最後の画面でそのまま起動できます）
3. 以降はスタートメニューの「SoyokazeMemo」から起動。アンインストールは「設定 > アプリ」から

> **「Windows によって PC が保護されました」と出た場合**
> コード署名をしていないアプリには SmartScreen の警告が出ます。「詳細情報」→「実行」で起動できます。

## 機能とショートカット

| 操作 | ショートカット |
| --- | --- |
| ペン / 消しゴム | `P` / `E`（ペンタブのペン尻は自動で消しゴム） |
| 投げ縄選択 | `L`（ペンでなぞるように囲んだ部分を持ち上げて動かす）、`Ctrl+A` で全体を選択 |
| 太さ（1〜80px） | スライダー、`[` / `]` |
| 色（8 色の落ち着いたパレット） | `1`〜`8` |
| 元に戻す / やり直す | `Ctrl+Z` / `Ctrl+Y`（`Ctrl+Shift+Z` も可） |
| 画像を貼り付け | `Ctrl+V`、またはエクスプローラーからドラッグ＆ドロップ |
| 画像をコピー（PNG） | `Ctrl+C`、または「画像をコピー」ボタン |
| すべて消去 | ゴミ箱ボタン（`Ctrl+Z` で戻せる） |

貼り付けた画像と、投げ縄で囲んだ範囲は「未確定」の状態で浮いていて、次の操作ができます。

| 操作 | 内容 |
| --- | --- |
| 画像の内側をドラッグ | 移動 |
| 角の □ をドラッグ | 拡大縮小（縦横比固定。`Shift` で比率フリー） |
| 上の ◯ をドラッグ | 回転（`Shift` で 15° 刻み） |
| ホイール / 矢印キー | 拡大縮小 / 1px 移動（`Shift` で 10px） |
| `Enter` / 画像の外側をクリック | 確定（キャンバスに焼き付け。以降はペン・消しゴムの対象） |
| `Esc` / `Ctrl+Z` | 取り消し（貼り付けは破棄、投げ縄は元の場所に戻す） |
| `Delete` | 貼り付けは破棄、投げ縄は囲んだ部分を削除 |

## 技術構成

| 役割 | 採用 | 理由 |
| --- | --- | --- |
| 描画 | HTML5 Canvas + TypeScript（フレームワークなし） | 機能が小さいので素の DOM で十分。バンドルは JS 40KB 程度 |
| ビルド | Vite | Tauri 公式テンプレートと同じ構成 |
| デスクトップ化 | **Tauri v2** | Windows 11 標準の WebView2 を使うのでインストーラーが数 MB（Electron は 80MB 超）。起動も速くメモリも軽い |
| クリップボード | Rust の [`arboard`](https://crates.io/crates/arboard) | Windows では `PNG` 形式と `CF_DIBV5` の両方を登録するので、Discord / Slack / LINE / Office / ペイント等どこにでも貼れる |
| インストーラー | Tauri bundler（NSIS / WiX） | `npm run tauri build` 一発で `.exe` と `.msi` を出力 |

実装方針の詳細（レイヤー構成、ペースト画像を確定させるまでの UI、PNG エクスポートの流れ、履歴管理）は [docs/DESIGN.md](docs/DESIGN.md) を参照してください。

## 環境構築（Windows 11）

PowerShell で以下を順に実行します（インストール済みのものはスキップで OK）。

### 1. Microsoft C++ Build Tools

Rust が Windows 向けにリンクするために必要です。

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

（Visual Studio 2022 本体の「C++ によるデスクトップ開発」ワークロードが入っていれば不要）

### 2. WebView2

Windows 11 には標準で入っているので作業不要です。

### 3. Rust

```powershell
winget install --id Rustlang.Rustup
# ターミナルを開き直してから
rustup default stable-msvc
```

### 4. Node.js（LTS）

```powershell
winget install --id OpenJS.NodeJS.LTS
```

### 5. 依存パッケージのインストール

```powershell
git clone https://github.com/ThunFasky/SoyokazeMemo.git
cd SoyokazeMemo
npm install
```

## 開発

```powershell
npm run tauri dev
```

初回は Rust のクレートのビルドで数分かかります。フロントエンド（`src/`）の変更はホットリロードされます。

UI だけ触りたいときはブラウザでも動きます（`npm run dev` → <http://localhost:1420>）。
このときクリップボード操作は Tauri ではなくブラウザの Async Clipboard API にフォールバックします。

## インストーラーのビルド

```powershell
npm run tauri build
```

出力先:

| 形式 | パス |
| --- | --- |
| NSIS（ユーザー単位インストール、管理者権限不要） | `src-tauri/target/release/bundle/nsis/SoyokazeMemo_0.2.0_x64-setup.exe` |
| MSI（WiX） | `src-tauri/target/release/bundle/msi/SoyokazeMemo_0.2.0_x64_ja-JP.msi` |

どちらもスタートメニューに登録され、「設定 > アプリ」からアンインストールできます。
普段使いなら NSIS 版（`-setup.exe`）がおすすめです。

- MSI のビルドで `light.exe` が失敗する場合は、Windows の「オプション機能」で **VBSCRIPT** が有効になっているか確認してください（WiX が内部で使用します）。
- ローカルに Rust 環境を作らなくても、GitHub Actions の **Windows installer** ワークフロー（`src/` や `src-tauri/` を push したとき、または Actions タブから手動実行）でビルドされます。Artifacts から `.exe` / `.msi` をそのままダウンロードできます（zip ではありません）。

## リリース（配布）の手順

GitHub でリリースを **Publish** すると、**Release** ワークフローがインストーラーをビルドしてそのリリースに添付します。

1. （必要なら）`src-tauri/tauri.conf.json` と `package.json` の `version` を上げて `main` にマージ
2. GitHub の **Releases → Draft a new release** を開き、タグ名を入力（例: `v0.1.0`、`Beta`。「Create new tag on publish」）→ **Publish release**
3. 10 分ほどでリリースに `-setup.exe` と `.msi` が追加される。配る相手にはリリースの URL を渡すだけ

- 既にあるリリースに添付し直したいときは、**Actions → Release → Run workflow** でタグ名を指定して実行します（リリースが無ければ作成されます）
- `v1.2.3` 形式のタグは、`tauri.conf.json` の `version` と一致しないと失敗します（取り違え防止）。`Beta` のような自由な名前ならチェックしません
- Draft のまま保存しただけでは動きません。Publish（または Pre-release として Publish）したときに動きます

SmartScreen の警告を消したい場合はコード署名が必要です（Azure Trusted Signing などの有料サービス）。個人で配る程度なら無署名のままで問題ありません。

## ディレクトリ構成

```
├─ index.html              タイトルバー・ツールバー・キャンバスの DOM
├─ src/
│  ├─ main.ts              UI の配線（ポインタ・キーボード・ペースト・D&D・トースト）
│  ├─ titlebar.ts          自前のタイトルバー（最小化・最大化・閉じる）
│  ├─ board.ts             描画レイヤーと Undo/Redo 履歴（コマンド方式）
│  ├─ floating.ts          貼り付け画像の移動・拡縮・回転と当たり判定
│  ├─ clipboard.ts         PNG 書き出し / 画像の取り込み
│  ├─ palette.ts           背景色・パレット・太さの範囲
│  └─ styles.css           テーマ（prefers-color-scheme で自動切替）
├─ src-tauri/
│  ├─ src/main.rs          Tauri の起動
│  ├─ src/clipboard.rs     OS クリップボードへの PNG 書き込み / 画像読み取り
│  ├─ tauri.conf.json      ウィンドウ・CSP・インストーラー設定
│  └─ icons/               アプリアイコン（assets/soyokazeMemoIcon.png から `npm run icons` で生成）
├─ assets/
│  ├─ soyokazeMemoIcon.png アイコンの元データ（50x50 のドット絵。タイトルバー左端にも表示）
│  └─ soyokazeMemoLogo.png タイトルバーのロゴ
├─ scripts/generate-icons.ps1  アイコン一式の生成（icon.ico などはドットが崩れないよう、サイズごとに整数倍の拡大や等倍の切り出しで作る）
└─ docs/DESIGN.md          実装方針
```
