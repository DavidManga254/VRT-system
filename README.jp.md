# ビジュアルリグレッションテストシステム

## 仕組み

```
デザイナーがpencil.devでデザインを作成・更新する
              ↓
開発者がReactコンポーネントを生成する（Vite+アプリ + Storybook）
              ↓
VRTシステムがpencil.devのデザインフレームをベースライン画像としてエクスポートする
              ↓
PlaywrightがStorybookの各ストーリーのスクリーンショットを撮影する
              ↓
スクリーンショットとpencil.devのベースラインをピクセル単位で比較する
              ↓
差異が見つかった場合 → Claude CodeがMCP経由でpencil.devを読み取り → コードを修正する
```

---

## 前提条件

### 1. Node.js

バージョン18以上が必要です。

```bash
node --version  # v18以上であること
```

### 2. Claude Code

Claude Codeをインストールし、認証を行い、VRTコマンドを実行するターミナルセッションで起動している必要があります。

**Claude Codeのインストール:**

```bash
npm install -g @anthropic-ai/claude-code
```

**Claude Codeの認証:**

明示的なClaudeセッションのないターミナル向けに、長期有効な認証トークンを生成するセットアップトークンコマンドを実行します:

```bash
claude setup-token
```

以下のような出力が表示されます:

```
✓ Long-lived authentication token created successfully!

Your OAuth token (valid for 1 year):

<<your-token-here>>

Store this token securely. You won't be able to see it again.
Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

**環境変数にトークンを設定する:**

**macOS / Linux** の場合:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=your_token_here
```

永続化するには、`~/.bashrc`、`~/.zshrc`、または `~/.bash_profile` に追加します:

```bash
echo 'export CLAUDE_CODE_OAUTH_TOKEN=your_token_here' >> ~/.zshrc
source ~/.zshrc
```

**Windows (PowerShell)** の場合:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN="your_token_here"
```

PowerShellで永続化するには、プロファイルに追加します:

```powershell
Add-Content $PROFILE "`n`$env:CLAUDE_CODE_OAUTH_TOKEN='your_token_here'"
```

Windowsのシステム設定で永続化する場合:

1. **システムのプロパティ** → **詳細設定** → **環境変数** を開く
2. **ユーザー環境変数** の下にある **新規** をクリック
3. 変数名: `CLAUDE_CODE_OAUTH_TOKEN`
4. 変数値: トークン

**Claude Codeの動作確認:**

```bash
claude --version
claude --print "hello"
```

### 3. Playwrightブラウザ

PlaywrightのChromiumをインストールします:

```bash
npm run install:browsers
```

### 4. pencil.dev

- [pencil.dev](https://pencil.dev) をダウンロードしてインストールする
- 設定 → エージェント を開き、Anthropic Claude Codeが接続されていることを確認する
- `vrt:sync` または `vrt:run` を実行する際は、必ず **`.pen` デザインファイルを開いた状態** で pencil.dev を起動しておく
- pencil.devはMCP経由でClaude Codeに自動的に接続します — 以下のコマンドで確認できます:

```bash
claude --print "list your active MCP servers"
```

アクティブなMCPサーバーとして `pencil` が表示されるはずです。

### 5. フロントエンドアプリ（Repo 1）

pencil.devで生成したReactアプリには以下が必要です:

- Storybookが `http://localhost:6006`（または設定したURL）で起動していること
- **すべてのコンポーネントにStorybookストーリーが存在すること** — VRTシステムはストーリーがあるコンポーネントのみテストします

> **規約:** pencil.devで生成されたすべてのコンポーネントは、テスト可能になる前に対応するStorybookストーリーが必要です。ストーリーなし = テストなし。

---

## 設定

### `.env` ファイルの作成

このリポジトリのルートに `.env` ファイルを作成します:

```dotenv
# Vite+ Reactアプリ（Repo 1）へのパス — 絶対パスの例（"C:\Users\User\Documents\GitHub\test"）
# ここにpencil.devがコンポーネントを生成した場所を指定します
REPO1_PATH=../your-app

# Claude Codeセッショントークン — 非インタラクティブなMCPアクセスに必要
# 生成方法: claude setup-token を実行する
# ここに設定するとともに、環境変数としても設定してください（前提条件を参照）
CLAUDE_CODE_SESSION_ACCESS_TOKEN=your_session_token_here

# Storybookが起動しているURL（デフォルト: http://localhost:6006）
# Storybookが別のポートやホストで起動している場合のみ変更してください
# Repo 1のStorybookが起動していることを確認してください
STORYBOOK_URL=http://localhost:6006
```

**各変数の説明:**

| 変数名                             | 必須 | 説明                                                                                                                                    |
| ---------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `REPO1_PATH`                       | 必須 | pencil.devがコンポーネントを生成したReactアプリへのパス。AIフィックスエージェントがここのソースファイルを読み取り、パッチを適用します。 |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | 必須 | Claude Codeを非インタラクティブモードで実行するための認証トークン。`vrt:sync` と `vrt:fix` がpencil MCPツールを呼び出すために必要です。 |
| `STORYBOOK_URL`                    | 任意 | Storybookが起動しているURL。デフォルトは `http://localhost:6006`。別のポートでStorybookを起動している場合に変更してください。           |

---

## 命名規則 — 重要

VRTシステムは、名前によってpencil.devのデザインフレームとStorybookストーリーを自動的に対応付けます。これが機能するためには、**pencil.devのコンポーネント名がStorybookのストーリータイトルに近い名前である必要があります**。

| pencil.devフレーム名 | Storybookストーリータイトル    | 一致？   |
| -------------------- | ------------------------------ | -------- |
| `Button/Primary`     | `Components/Button > Primary`  | ✓ 一致   |
| `Dashboard/Frame 74` | `Components/Frame74 > Default` | ✓ 一致   |
| `MyCard`             | `Components/Card > Default`    | ✓ 一致   |
| `xyz123`             | `Components/Button > Primary`  | ✗ 不一致 |

名前が一致しない場合、同期時に未マッチのノードが報告され、そのコンポーネントはpencil.devのベースラインを取得できません。

---

## ワークフロー

### 初回セットアップ（新規プロジェクト開始時）

```bash
# 1. Repo 1でStorybookを起動しておく
# 2. pencil.devを.penファイルを開いた状態で起動しておく

# Storybookからテストファイルを生成する
npm run vrt:generate

# pencil.devのデザインフレームをベースラインとして取得する
npm run vrt:sync
```

### 日常的な使用方法

pencil.devが新規または更新されたコンポーネントを生成した後:

```bash
npm run vrt:run
```

これにより、フルパイプラインが自動的に実行されます:

1. Storybookからストーリーを検出する
2. Playwrightのビジュアルテストを実行する
3. 失敗が見つかった場合 → Claude CodeがMCP経由でpencil.devのデザインを読み取り、コードを修正する
4. テストを再実行して修正を確認する

### デザイナーがpencil.devのデザインを更新した場合

```bash
# 更新されたデザインフレームを新しいベースラインとして再取得する
npm run vrt:sync

# 更新されたベースラインに対してテストを実行する
npm run vrt:run
```

---

## 利用可能なコマンド

| コマンド                        | 説明                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `npm run vrt:run`               | フルパイプライン — 生成・テスト・修正・確認                      |
| `npm run vrt:run:update`        | 現在のStorybookの状態からベースラインをリセットする              |
| `npm run vrt:run:skip-fix`      | テストのみ実行、AIフィックスエージェントをスキップ               |
| `npm run vrt:run:skip-generate` | ストーリーの検出をスキップし、既存のテストファイルを使用         |
| `npm run vrt:generate`          | Storybookストーリーを検出してテストファイルを生成する            |
| `npm run vrt:sync`              | pencil.devのデザインフレームをベースラインとしてエクスポートする |
| `npm run vrt:fix`               | 最後の失敗セットに対してAIフィックスエージェントを実行する       |
| `npm run vrt:report`            | 最後のPlaywright HTMLレポートを開く                              |
| `npm run install:browsers`      | PlaywrightのChromiumブラウザをインストールする                   |

---

## 重要なルール

**`vrt:sync` または `vrt:run` を実行する際は常にpencil.devを開いておく。** AIフィックスエージェントはコンポーネントを修正する際にMCP経由でpencil.devに接続し、デザイン仕様を読み取ります。

**VRTコマンドを実行する前に常にStorybookを起動しておく。** すべてのスクリプトは `localhost:6006`（または設定した `STORYBOOK_URL`）からストーリーデータを取得します。

**修正を適用する前にファイルをバックアップしておく。** AIフィックスエージェントはパッチを適用する前に自動的に `.bak` バックアップファイルを作成します（例: `Button.css.bak`）。コミットする前に差分を確認してください。

---

## トラブルシューティング

**`Claude Code exited with code null`**

Claude Codeがタイムアウトしたか、ツールのアクセス権限が拒否されました。インタラクティブモードで実行して何が起きているか確認してください:

**`No nodes were matched`**

pencil.devのフレーム名がStorybookのストーリー名と十分に一致していません。pencil.devのフレームをコンポーネント名に合わせてリネームしてください（上記の命名規則を参照）。

**テストが通るがコンポーネントの見た目がおかしい**

ベースライン画像が古い可能性があります。pencil.devから再同期してください:

```bash
npm run vrt:sync
```

---

## AIフィックスエージェントの仕組み

テストが失敗すると、AIフィックスエージェントは以下を実行します:

1. `reports/results.json` を読み取って失敗したテストを特定する
2. `REPO1_PATH` 内でコンポーネントのソースファイル（`.tsx` と `.css`）を検索する
3. 3つの画像を収集する: **期待値**（pencil.devベースライン）、**実際の値**（現在のスクリーンショット）、**差分**（差異のハイライト）
4. 上記すべてと修正依頼のプロンプトをClaude Codeに送信する
5. Claude Codeがpencil MCPを呼び出して正確なデザイン仕様（色・スペーシング・フォントサイズ・ボーダー半径）を読み取る
6. Claude Codeが最小限のパッチを生成する — 必要な変更のみ行う
7. パッチが `REPO1_PATH` 内のソースファイルに直接適用される
8. パッチされたすべてのファイルに対してバックアップ `.bak` ファイルが作成される
9. Playwrightが再実行されて修正を確認する

すべての修正は診断内容、信頼度レベル、適用された正確なパッチとともに `reports/ai-fixes.json` に記録されます。
