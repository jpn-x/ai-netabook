// スーパーAIネタ帳: Service Worker
// ブラウザ/タブが閉じていてもPush通知を受け取るための最小実装。
// 通知本文はプライバシー保護のため送信側(サーバー)には持たせず、
// ここでランダムに選んで表示する(サーバーは「送る」だけを担当)。

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const MESSAGES = [
  '今日、何かあった？',
  '今日の一言、まだありません。',
  'どうでもいいことでOK。',
  '今日は一問だけどうぞ。'
];

self.addEventListener('push', (event) => {
  const body = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  event.waitUntil(
    self.registration.showNotification('スーパーAIネタ帳', {
      body,
      icon: undefined,
      tag: 'ai-netabook-daily'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
