# SoyokazeMemo

一時的な手書きメモ　コピペなどするときに

チャットにちょっと図を貼りたい、スクショに丸を付けて送りたい——そんなとき用の、**出力先がクリップボードだけ**の軽量ペイントアプリです。
ファイル保存機能は意図的に持たせていません。描いて `Ctrl+C`（Mac は `⌘+C`）、チャットで貼り付け、それだけ。

- Windows 11 / macOS のネイティブアプリ（Tauri v2。Windows は WebView2、Mac は WKWebView）
- インストーラー（Windows: `.exe` / `.msi`、Mac: `.dmg`）を出力可能
- UI は OS のライト / ダークモードに自動追従、キャンバスは目に優しい下書き用紙グレー `#D9DCD6`

## インストール（使うだけの人向け）

### Windows

1. [Releases](https://github.com/ThunFasky/SoyokazeMemo/releases/latest) から `SoyokazeMemo_x.y.z_x64-setup.exe` をダウンロード
2. ダブルクリックしてインストール（管理者権限は不要。最後の画面でそのまま起動できます）
3. 以降はスタートメニューの「SoyokazeMemo」から起動。アンインストールは「設定 > アプリ」から

> **「Windows によって PC が保護されました」と出た場合**
> コード署名をしていないアプリには SmartScreen の警告が出ます。「詳細情報」→「実行」で起動できます。

### macOS（12 Monterey 以降。Intel / Apple シリコンどちらも OK）

1. [Releases](https://github.com/ThunFasky/SoyokazeMemo/releases/latest) から `SoyokazeMemo_x.y.z_universal.dmg` をダウンロード
2. 開いて、SoyokazeMemo を「アプリケーション」フォルダにドラッグ
3. 初回だけ、下の手順で「このまま開く」を許可する（2 回目以降は普通に起動できます）

> **「“SoyokazeMemo”は開いていません」「開発元を検証できません」と出た場合**
> Apple の公証（有料の開発者登録が必要）を受けていないアプリなので、初回は macOS に止められます。
>
> - **macOS 15 Sequoia 以降**: 一度開こうとして「完了」で閉じたあと、**システム設定 → プライバシーとセキュリティ** を一番下までスクロールし、SoyokazeMemo の **「このまま開く」** を押す（パスワードを聞かれます）
> - **macOS 14 Sonoma 以前**: Finder で「アプリケーション」の SoyokazeMemo を **右クリック → 開く** → 「開く」
>
> どうしても開けないときは、ターミナルで `xattr -dr com.apple.quarantine /Applications/SoyokazeMemo.app` を実行してから開いてください。

Mac 版の違い:

- ショートカットは `Ctrl` の代わりに `⌘` です（`⌘+Z` / `⌘+Shift+Z` / `⌘+C` / `⌘+V` / `⌘+Shift+V` など）。画面の表示も `⌘` になります
- ウィンドウの 閉じる / しまう / フルスクリーン は、左上の Mac 標準のボタンです。`⌘+W` で閉じ、`⌘+Q` で終了します
- 「画面から取得」は今のところ Windows 版だけです（Mac では `⌘+Shift+4` などで撮ってから「クリップボードから開く」を使ってください。`⌘+Ctrl+Shift+4` ならクリップボードに直接撮れます）
- macOS と Safari は最新にしておいてください（アプリの画面は Mac の Safari と同じ WebKit で動いています）

## 機能とショートカット

Mac では `Ctrl` を `⌘` に読み替えてください。

| 操作 | ショートカット |
| --- | --- |
| ペン / 消しゴム | `P` / `E`（ペンタブのペン尻は自動で消しゴム） |
| 投げ縄選択 | `L`（ペンでなぞるように囲んだ部分を持ち上げて動かす）、`Ctrl+A` で全体を選択 |
| バケツ（塗りつぶし） | `G`（クリックした所と同じ色でつながっている範囲を、今の色で塗る） |
| 拡大・縮小 | `Ctrl` + ホイール（カーソルの位置を中心に。タッチパッドのピンチでも OK）、`Ctrl+=` / `Ctrl+-` |
| 表示を元に戻す | `Ctrl+0`、または右下の倍率表示をクリック |
| 表示を動かす | ホイール（`Shift` で左右）、`Space` + ドラッグ、ホイールボタン（中ボタン）でドラッグ |
| 太さ（1〜80px） | スライダー、`[` / `]` |
| 色（8 色の落ち着いたパレット） | `1`〜`8` |
| 元に戻す / やり直す | `Ctrl+Z` / `Ctrl+Y`（`Ctrl+Shift+Z` も可） |
| 画像を貼り付け | `Ctrl+V`、またはエクスプローラーからドラッグ＆ドロップ |
| 画面の一部を撮ってキャンバスにする | 「画面から取得」ボタン（範囲選択中は `Esc` / 右クリックでキャンセル。Windows 版のみ） |
| クリップボードの画像をそのままキャンバスにする | `Ctrl+Shift+V`、または「クリップボードから開く」ボタン |
| 画像をコピー（PNG） | `Ctrl+C`、または「画像をコピー」ボタン |
| すべて消去 | ゴミ箱ボタン（`Ctrl+Z` で戻せる） |

### スクショにそのまま書き込む（クリップボードから開く）

Snipping Tool（`Win+Shift+S`）などでスクショを撮ったら、「クリップボードから開く」ボタン（`Ctrl+Shift+V`）を押すだけで、その画像がそのままキャンバスになります。
丸や矢印を描いて `Ctrl+C` すれば、**元のスクショと同じ大きさ・解像度**でコピーされます（周りのグレーは入りません）。

- 画像は「紙（下地）」になります。消しゴムで消えるのは自分の書き込みだけで、スクショ自体は消えません。投げ縄で動かせるのも書き込みだけです
- 画面に収まる大きさなら、画像 1px = 画面 1px でそのまま表示します。収まらない大きな画像は縮小して表示しますが、書き出しは元の大きさのままです
- `Ctrl+V` での貼り付けやドラッグ＆ドロップは、これまで通りキャンバスの上に重ねる画像になります（画像キャンバスの上では、その画像の 1px = キャンバスの 1px で置きます）
- `Ctrl+Z` で開く前のキャンバスに戻せます。ゴミ箱で画像ごと消すと、白紙の通常のキャンバスに戻ります
- エクスプローラーでコピーした画像ファイルも開けます

### 画面の一部を撮って書き込む（画面から取得）

「画面から取得」ボタンを押すと、**押した瞬間の画面**（全モニター）が静止画になって全面に表示されます。
ドラッグで四角形に囲んで離すと、その範囲がそのままキャンバスになります（「クリップボードから開く」と同じ画像キャンバス）。

- 撮るのはボタンを押した瞬間の 1 回だけです。範囲を選んでいる間に動画などが動いても、選ぶのは止まった画面からです
- SoyokazeMemo 自身のウィンドウは、撮る直前に隠すので写り込みません（選び終わると元に戻ります）
- ドラッグはどの向きからでも OK。`Shift` を押しながらだと正方形になります。ただのクリックでは何も起きません（選び直せます）
- `Esc` か右クリックでキャンセルすると、キャンバスは何も変わりません
- 撮った範囲は画面と同じ解像度のまま（1px = 1px）キャンバスになり、`Ctrl+C` でその大きさのままコピーできます。`Ctrl+Z` で前のキャンバスに戻せます
- Windows 版専用です（Mac 版とブラウザで開いた開発用の画面では使えません）

### 拡大・縮小と表示の移動

- `Ctrl` + ホイールで 10%〜1600% まで拡大・縮小できます。拡大中に描く線の太さは、画面上の見た目の太さです（細かい所を描き込みやすい）
- 拡大・縮小しているときは、右下に倍率が出ます。クリックするか `Ctrl+0` で最初の表示に戻ります
- ウィンドウの左辺や上辺をつかんでサイズを変えても、描いたものは画面上で動きません（右辺・下辺と同じ感覚で縮められます）
- `Ctrl+C` でコピーされる範囲:
  - 通常のキャンバス: **見えているとおり**（拡大中は見えている部分を、縮小中は見えている全体を、ウィンドウと同じ大きさで）
  - 画像キャンバス（クリップボードから開く / 画面から取得）: 倍率に関係なく、元の画像の大きさ・解像度のまま

### バケツ（塗りつぶし）

`G` でバケツにして、塗りたい所をクリックします。見えている色（背景・下地の画像・書き込み）で範囲を決めるので、線で囲んだ中や、スクショの枠の中を塗れます。

- 線のフチとの間にすき間が残らないよう、外周 1px は線の下に潜らせて塗ります（線は消えません）
- 塗った所は書き込みと同じ扱いなので、消しゴムで消したり、投げ縄で動かしたり、別の色で塗り直したりできます。`Ctrl+Z` で戻せます
- 通常のキャンバスで塗れるのは見えている範囲までです（何もない所を塗ると、見えている背景全体が塗られます）

貼り付けた画像と、投げ縄で囲んだ範囲は「未確定」の状態で浮いていて、次の操作ができます。

| 操作 | 内容 |
| --- | --- |
| 画像の内側をドラッグ | 移動 |
| 角の □ をドラッグ | 拡大縮小（縦横比固定。`Shift` で比率フリー） |
| 上の ◯ をドラッグ | 回転（`Shift` で 15° 刻み） |
| ホイール / 矢印キー | 画像の拡大縮小（`Ctrl` + ホイールは表示の拡大縮小） / 1px 移動（`Shift` で 10px） |
| `Enter` / 画像の外側をクリック | 確定（キャンバスに焼き付け。以降はペン・消しゴムの対象） |
| `Esc` / `Ctrl+Z` | 取り消し（貼り付けは破棄、投げ縄は元の場所に戻す） |
| `Delete` | 貼り付けは破棄、投げ縄は囲んだ部分を削除 |

## 技術構成

| 役割 | 採用 | 理由 |
| --- | --- | --- |
| 描画 | HTML5 Canvas + TypeScript（フレームワークなし） | 機能が小さいので素の DOM で十分。バンドルは JS 40KB 程度 |
| ビルド | Vite | Tauri 公式テンプレートと同じ構成 |
| デスクトップ化 | **Tauri v2** | OS 標準の WebView（Windows 11 は WebView2、Mac は WKWebView）を使うのでインストーラーが数 MB（Electron は 80MB 超）。起動も速くメモリも軽い |
| クリップボード | Rust の [`arboard`](https://crates.io/crates/arboard) | Windows では `PNG` 形式と `CF_DIBV5` の両方を登録するので、Discord / Slack / LINE / Office / ペイント等どこにでも貼れる。Mac では標準のペーストボードに画像として書き込む |
| インストーラー | Tauri bundler（NSIS / WiX / DMG） | `npm run tauri build` 一発で、Windows では `.exe` と `.msi`、Mac では `.app` と `.dmg` を出力 |

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

## 環境構築（macOS）

Mac で開発・ビルドする場合です（Windows だけで開発するなら不要。Mac 版は GitHub Actions でもビルドできます）。

```sh
xcode-select --install                              # Xcode Command Line Tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
brew install node                                   # Node.js（https://nodejs.org からでも可）

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

Mac で Intel / Apple シリコン両対応（ユニバーサル）の `.dmg` を作るときは、最初に一度ターゲットを追加してから:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

出力先:

| 形式 | パス |
| --- | --- |
| NSIS（ユーザー単位インストール、管理者権限不要） | `src-tauri/target/release/bundle/nsis/SoyokazeMemo_0.6.0_x64-setup.exe` |
| MSI（WiX） | `src-tauri/target/release/bundle/msi/SoyokazeMemo_0.6.0_x64_ja-JP.msi` |
| Mac（ユニバーサル） | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/SoyokazeMemo_0.6.0_universal.dmg` |

Windows 版はどちらもスタートメニューに登録され、「設定 > アプリ」からアンインストールできます。
普段使いなら NSIS 版（`-setup.exe`）がおすすめです。
Mac 版は `tauri.conf.json` に `tauri.macos.conf.json` が重なって、Mac 用のウィンドウ設定（標準の信号機ボタン）と `.app` / `.dmg` の設定になります。

- MSI のビルドで `light.exe` が失敗する場合は、Windows の「オプション機能」で **VBSCRIPT** が有効になっているか確認してください（WiX が内部で使用します）。
- ローカルに Rust 環境を作らなくても、GitHub Actions の **Windows installer** ワークフロー（`src/` や `src-tauri/` を push したとき、または Actions タブから手動実行）でビルドされます。Artifacts から `.exe` / `.msi` をそのままダウンロードできます（zip ではありません）。Mac 版は **macOS app** ワークフローで `.dmg` がビルドされます。

## リリース（配布）の手順

GitHub でリリースを **Publish** すると、**Release** ワークフローが Windows 版と Mac 版のインストーラーを並行してビルドし、そのリリースに添付します。

1. （必要なら）`src-tauri/tauri.conf.json` と `package.json` の `version` を上げて `main` にマージ
2. GitHub の **Releases → Draft a new release** を開き、タグ名を入力（例: `v0.1.0`、`Beta`。「Create new tag on publish」）→ **Publish release**
3. 10〜15 分ほどでリリースに `-setup.exe` / `.msi`（Windows）と `_universal.dmg`（Mac）が追加される。配る相手にはリリースの URL を渡すだけ

- 既にあるリリースに添付し直したいときは、**Actions → Release → Run workflow** でタグ名を指定して実行します（リリースが無ければ作成されます）
- `v1.2.3` 形式のタグは、`tauri.conf.json` の `version` と一致しないと失敗します（取り違え防止）。`Beta` のような自由な名前ならチェックしません
- Draft のまま保存しただけでは動きません。Publish（または Pre-release として Publish）したときに動きます

- 片方の OS のビルドが失敗しても、もう片方は添付されます

SmartScreen の警告を消したい場合はコード署名が必要です（Azure Trusted Signing などの有料サービス）。
Mac の「開発元を検証できません」を出さないようにするには、Apple Developer Program（年 99 ドル）に登録して Developer ID で署名し、Apple の公証（Notarization）を受ける必要があります。
今の Mac 版はアドホック署名（`signingIdentity: "-"`）なので、初回だけ「このまま開く」の操作が必要です。個人で配る程度ならどちらも無署名のままで問題ありません。

## ディレクトリ構成

```
├─ index.html              タイトルバー・ツールバー・キャンバスの DOM
├─ capture.html            「画面から取得」の範囲選択画面（全モニターを覆う別ウィンドウ）
├─ src/
│  ├─ main.ts              UI の配線（ポインタ・キーボード・ペースト・D&D・トースト）
│  ├─ titlebar.ts          自前のタイトルバー（Windows: 最小化・最大化・閉じる / Mac: OS の信号機ボタンを使う）
│  ├─ platform.ts          OS ごとの違い（Mac の判定、ショートカット表記の Ctrl → ⌘）
│  ├─ board.ts             描画レイヤーと Undo/Redo 履歴（コマンド方式）、画像キャンバスの配置
│  ├─ floating.ts          貼り付け画像の移動・拡縮・回転と当たり判定
│  ├─ clipboard.ts         PNG 書き出し / 画像の取り込み
│  ├─ screen.ts            「画面から取得」の呼び出し（Rust 側から生の RGBA を受け取る）
│  ├─ capture.ts / .css    範囲選択画面（静止画を暗く敷き、ドラッグした四角形を選ぶ）
│  ├─ palette.ts           背景色・パレット・太さの範囲
│  └─ styles.css           テーマ（prefers-color-scheme で自動切替）
├─ src-tauri/
│  ├─ src/main.rs          Tauri の起動
│  ├─ src/clipboard.rs     OS クリップボードへの PNG 書き込み / 画像読み取り
│  ├─ src/screen_capture.rs 画面全体の撮影（GDI）と範囲選択ウィンドウの管理
│  ├─ tauri.conf.json      ウィンドウ・CSP・インストーラー設定
│  ├─ tauri.macos.conf.json Mac でビルドしたときだけ重なる設定（信号機ボタン・.dmg・アドホック署名）
│  └─ icons/               アプリアイコン（assets/soyokazeMemoIcon.png から `npm run icons` で生成）
├─ assets/
│  ├─ soyokazeMemoIcon.png アイコンの元の絵（SoyokazeMemo で描いたもの。正方形でなくてよい）
│  ├─ titlebar-icon*.png   タイトルバー左端のアイコン（`npm run icons` で生成。20px と高 DPI 用の 40px）
│  └─ soyokazeMemoLogo.png タイトルバーのロゴ
├─ .github/workflows/     Windows / Mac のビルド（push ごと）と、リリースへの添付
├─ scripts/generate-icons.ps1  アイコン一式の生成（絵を紙色の角丸タイルに収め、小さいサイズは線を太らせてから縮小）
└─ docs/DESIGN.md          実装方針
```
