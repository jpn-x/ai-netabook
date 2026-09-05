# AIネタ帳 発見プロキシ (Cloudflare Worker)

フロントエンド（`ai-netabook.pages.dev`）から、ユーザーのメモ本文を受け取り、
Gemini APIを呼び出して「AIからの発見」を生成して返すだけの薄いプロキシです。

- APIキーはこのWorkerの環境シークレットとして保持し、フロントエンドには一切渡しません。
- メモ本文はこの処理のためだけに一時的に転送されるだけで、Worker側には保存しません。
- `GEMINI_API_KEY` が未設定の場合は `501` を返し、フロントエンドは自動的にローカルのルールベースAIへフォールバックします（エラー表示なし）。

## 有効化する方法（無料）

1. https://aistudio.google.com/apikey で無料のGemini APIキーを取得
2. このディレクトリで以下を実行:
   ```
   wrangler secret put GEMINI_API_KEY
   ```
   と入力を求められたらキーを貼り付け
3. `wrangler deploy` で反映

キーを設定するまでは、これまで通りローカルのルールベースAIで動作します。

## 無料枠について

Gemini APIの無料枠・レート制限は変動するため、実装当時の内容を鵜呑みにせず
https://ai.google.dev/pricing で最新の公式情報を確認してください。
