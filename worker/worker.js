// スーパーAIネタ帳: バックエンドプロキシ
// 1. /discover  … メモをGemini APIへ渡して「AIからの発見」を生成する薄いプロキシ
// 2. /subscribe … Web Push購読情報を保存する
// 3. scheduled  … Cronで1時間おきに起動し、選ばれた時間帯のユーザーへ
//                 「今日、何かあった？」程度の軽いPush通知を送る（本文はSW側で決める）
//
// ユーザーのメモ本文はGemini呼び出しの都度だけ一時的に転送し、保存はしない。
// Push購読情報（endpoint等。メモ本文は含まない）だけをKVに保存する。

const ALLOWED_ORIGIN = 'https://ai-netabook.pages.dev';

const TIME_WINDOWS = {
  'お昼ごろ': [11, 14], '午後': [14, 17], '夕方': [17, 19],
  '夜': [19, 22], '寝る前': [21, 24], 'おまかせ': [11, 22]
};

export default {
  async fetch(request, env) {
    const headers = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });

    const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: jsonHeaders });
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: jsonHeaders }); }

    if (url.pathname === '/discover') {
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers: jsonHeaders });
      }
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 30) : [];
      if (notes.length < 3) {
        return new Response(JSON.stringify({ hasDiscovery: false, text: '' }), { headers: jsonHeaders });
      }
      const result = await callGemini(env.GEMINI_API_KEY, buildDiscoveryPrompt(notes));
      return new Response(JSON.stringify(result), { headers: jsonHeaders });
    }

    if (url.pathname === '/subscribe') {
      if (!env.SUBSCRIPTIONS) {
        return new Response(JSON.stringify({ error: 'not_configured' }), { status: 501, headers: jsonHeaders });
      }
      const sub = body.subscription;
      const slot = typeof body.slot === 'string' ? body.slot : 'おまかせ';
      if (!sub || !sub.endpoint) {
        return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: jsonHeaders });
      }
      const key = await sha256Hex(sub.endpoint);
      await env.SUBSCRIPTIONS.put(key, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, slot, lastSentDate: null }));
      return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
    }

    if (url.pathname === '/unsubscribe') {
      if (!env.SUBSCRIPTIONS || !body.endpoint) {
        return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
      }
      const key = await sha256Hex(body.endpoint);
      await env.SUBSCRIPTIONS.delete(key);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: jsonHeaders });
  },

  // Cronトリガー: 1時間おきに実行され、選ばれた時間帯 & 本日未送信の購読者へ軽いPushを送る
  async scheduled(event, env, ctx) {
    if (!env.SUBSCRIPTIONS || !env.VAPID_PRIVATE_KEY_PKCS8_B64) return;
    const now = new Date();
    const jstHour = (now.getUTCHours() + 9) % 24;
    const today = now.toISOString().slice(0, 10);
    const list = await env.SUBSCRIPTIONS.list();
    for (const k of list.keys) {
      const raw = await env.SUBSCRIPTIONS.get(k.name);
      if (!raw) continue;
      const sub = JSON.parse(raw);
      const win = TIME_WINDOWS[sub.slot] || TIME_WINDOWS['おまかせ'];
      if (jstHour < win[0] || jstHour >= win[1]) continue;
      if (sub.lastSentDate === today) continue;
      try {
        await sendPush(sub, env);
        sub.lastSentDate = today;
        await env.SUBSCRIPTIONS.put(k.name, JSON.stringify(sub));
      } catch (e) {
        if (e && e.gone) await env.SUBSCRIPTIONS.delete(k.name);
      }
    }
  }
};

/* ===================== Web Push (VAPID, ペイロードなし) ===================== */
async function sendPush(sub, env) {
  const endpointOrigin = new URL(sub.endpoint).origin;
  const jwt = await buildVapidJwt(endpointOrigin, env);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'TTL': '86400',
      'Content-Length': '0'
    }
  });
  if (res.status === 404 || res.status === 410) { const err = new Error('gone'); err.gone = true; throw err; }
  if (!res.ok) throw new Error('push_failed_' + res.status);
}

async function buildVapidJwt(audience, env) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com'
  };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const key = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY_PKCS8_B64);
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  return signingInput + '.' + b64urlBuf(sigBuf);
}

async function importVapidPrivateKey(b64) {
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

function b64url(str) { return b64urlBuf(new TextEncoder().encode(str)); }
function b64urlBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ===================== Gemini（AIからの発見） ===================== */
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
