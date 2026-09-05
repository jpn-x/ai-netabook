// スーパーAIネタ帳: AI発見プロキシ
// フロントエンド(ai-netabook.pages.dev)から、ユーザーのメモ本文を受け取り、
// Gemini APIを呼び出して「発見」を生成して返すだけの薄いプロキシ。
// APIキーはこのWorkerの環境変数(secret)として保持し、フロントエンドには一切渡さない。
// メモ本文はこの処理のためだけに一時的に転送され、保存はしない。

const ALLOWED_ORIGIN = 'https://ai-netabook.pages.dev';

export default {
  async fetch(request, env) {
    const headers = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: jsonHeaders });
    }

    if (!env.GEMINI_API_KEY) {
      // キー未設定 = ルールベースのローカルAIへ静かにフォールバックさせる合図
      return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers: jsonHeaders });
    }

    const url = new URL(request.url);
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: jsonHeaders });
    }

    if (url.pathname === '/discover') {
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 30) : [];
      if (notes.length < 3) {
        return new Response(JSON.stringify({ hasDiscovery: false, text: '' }), { headers: jsonHeaders });
      }
      const prompt = buildDiscoveryPrompt(notes);
      const result = await callGemini(env.GEMINI_API_KEY, prompt);
      return new Response(JSON.stringify(result), { headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: jsonHeaders });
  }
};

function buildDiscoveryPrompt(notes) {
  const list = notes.map((n, i) => `${i + 1}. (${n.date || ''}) ${n.text}`).join('\n');
  return `あなたは「スーパーAIネタ帳」というサービスのAIです。
ユーザーが日々残した、何気ない一言メモの一覧を渡します。

これらのメモを、事実・テーマ・キーワード・感情の観点からゆるく見て、
複数のメモに共通する「点と点のつながり」が本当にある場合だけ、
日本語で短い発見を作ってください。

絶対に守るルール:
- ユーザーを「素晴らしい」「天才」「最高」のように褒めない。ユーザー自身の記録から気づきを提示するだけにする。
- 断定せず「〜かもしれません」「〜のようです」を使う。
- メモに書かれていない事実を勝手に作らない。
- 本当につながりが見つからない場合は、無理に作らず hasDiscovery を false にする。
- 3〜4文以内。絵文字は0〜1個まで。攻撃的・下品・センシティブな内容は書かない。

メモ一覧:
${list}

次のJSON形式だけを出力してください（説明文やコードブロック記号は不要）:
{"hasDiscovery": true または false, "text": "発見の本文。falseなら空文字", "relatedIndexes": [関連するメモの番号の配列]}`;
}

async function callGemini(apiKey, prompt) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
        })
      }
    );
    if (!res.ok) return { hasDiscovery: false, text: '', error: 'upstream_error' };
    const data = await res.json();
    const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      ? data.candidates[0].content.parts[0].text : '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { hasDiscovery: false, text: '' };
    const parsed = JSON.parse(match[0]);
    return {
      hasDiscovery: !!parsed.hasDiscovery,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      relatedIndexes: Array.isArray(parsed.relatedIndexes) ? parsed.relatedIndexes : []
    };
  } catch (e) {
    return { hasDiscovery: false, text: '', error: 'exception' };
  }
}
