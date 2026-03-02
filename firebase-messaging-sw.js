/**
 * firebase-messaging-sw.js
 *
 * THIS FILE MUST STAY AT THE ROOT of your domain (same level as index.html).
 * Firebase Cloud Messaging requires it at exactly: /firebase-messaging-sw.js
 *
 * This SW handles BACKGROUND push notifications — messages that arrive when:
 *   • The browser is fully closed
 *   • The PWA is installed and running in background
 *   • The phone screen is off
 *   • The user is in another app entirely
 *
 * It works alongside sw.js (which handles caching + foreground notifications).
 * Both service workers run concurrently — this one is registered automatically
 * by the Firebase SDK, sw.js is registered manually in each HTML page.
 */

// ─── FIREBASE CONFIG (must be repeated here — SW has no module imports) ────────
// ⚠️  KEEP THIS IN SYNC with js/firebase-config.js
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA_h36fA_bjB9dA35_FWpcO15fsdMOXr4M",
  authDomain:        "aschat-10454.firebaseapp.com",
  databaseURL:       "https://aschat-10454-default-rtdb.firebaseio.com",
  projectId:         "aschat-10454",
  storageBucket:     "aschat-10454.firebasestorage.app",
  messagingSenderId: "1000988226480",
  appId:             "1:1000988226480:web:24ef431489b19037e49c75"
};

// ─── IMPORT FIREBASE MESSAGING COMPAT SDK (required for SW context) ───────────
// The compat SDK is the only version that works inside a service worker
// without bundlers. It uses importScripts, which is fine in SW context.
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp(FIREBASE_CONFIG);

const messaging = firebase.messaging();

// ─── BACKGROUND MESSAGE HANDLER ───────────────────────────────────────────────
//
// This fires when a push arrives and NO app window is open / focused.
// The Cloud Function (functions/index.js) sends the push with a `data` payload
// (not `notification`) so WE control the notification appearance here.
//
// If the Cloud Function sends a `notification` payload, Firebase shows it
// automatically WITHOUT calling this handler. We avoid that because we need
// custom actions (Accept/Decline on calls).

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const type = data.type;

  if (!type) return;

  switch (type) {

    case 'message':
      return showMessageNotification(data);

    case 'call':
      return showCallNotification(data);

    case 'missed_call':
      return showMissedCallNotification(data);

    case 'reaction':
      return showReactionNotification(data);

    default:
      console.warn('[FCM-SW] Unknown push type:', type);
  }
});

// ─── NOTIFICATION BUILDERS ────────────────────────────────────────────────────

function showMessageNotification(data) {
  const { senderName, senderID, text, senderPhoto } = data;

  return self.registration.showNotification(`ASChat — ${senderName}`, {
    body:             text || 'New message',
    icon:             senderPhoto || '/icons/icon-192.png',
    badge:            '/icons/icon-192.png',
    tag:              'msg-' + senderID,
    renotify:         true,
    silent:           false,
    vibrate:          [200, 100, 200],
    timestamp:        Date.now(),
    data: {
      type:       'message',
      senderID,
      senderName,
      url:        `/chat.html?id=${senderID}&name=${encodeURIComponent(senderName)}`
    },
    actions: [
      { action: 'open',  title: '💬 Open' },
      { action: 'close', title: '✕ Dismiss' }
    ]
  });
}

function showCallNotification(data) {
  const { callerName, callerID, callType, callerPhoto } = data;
  const icon  = callType === 'video' ? '📹' : '📞';
  const label = callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call';

  return self.registration.showNotification(`ASChat — ${callerName}`, {
    body:               `${icon} ${label}`,
    icon:               callerPhoto || '/icons/icon-192.png',
    badge:              '/icons/icon-192.png',
    tag:                'call-' + callerID,
    renotify:           true,
    requireInteraction: true,          // Stays until user acts — like WhatsApp
    silent:             false,
    vibrate:            [500, 200, 500, 200, 500],
    timestamp:          Date.now(),
    data: {
      type:       'call',
      callerID,
      callerName,
      callType,
      url:        `/chat.html?id=${callerID}&name=${encodeURIComponent(callerName)}&autocall=accept&calltype=${callType}`
    },
    actions: [
      { action: 'accept',  title: '✅ Accept' },
      { action: 'decline', title: '❌ Decline' }
    ]
  });
}

function showMissedCallNotification(data) {
  const { callerName, callerID, callType, callerPhoto } = data;
  const icon = callType === 'video' ? '📹' : '📞';

  return self.registration.showNotification(`ASChat — Missed call from ${callerName}`, {
    body:      `${icon} Missed ${callType} call`,
    icon:      callerPhoto || '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       'missed-' + callerID,
    renotify:  true,
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: Date.now(),
    data: {
      type:       'message',
      senderID:   callerID,
      senderName: callerName,
      url:        `/chat.html?id=${callerID}&name=${encodeURIComponent(callerName)}`
    },
    actions: [
      { action: 'open',  title: '💬 Open Chat' },
      { action: 'close', title: '✕ Dismiss' }
    ]
  });
}

function showReactionNotification(data) {
  const { senderName, senderID, emoji, senderPhoto } = data;

  return self.registration.showNotification(`ASChat — ${senderName}`, {
    body:      `Reacted ${emoji} to your message`,
    icon:      senderPhoto || '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       'reaction-' + senderID,
    renotify:  true,
    silent:    true,
    vibrate:   [100],
    timestamp: Date.now(),
    data: {
      type:       'message',
      senderID,
      senderName,
      url:        `/chat.html?id=${senderID}&name=${encodeURIComponent(senderName)}`
    },
    actions: [
      { action: 'open',  title: '💬 Open' },
      { action: 'close', title: '✕ Dismiss' }
    ]
  });
}

// ─── NOTIFICATION CLICK ───────────────────────────────────────────────────────
// Firebase Messaging SW doesn't auto-handle clicks — we must do it here.

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const action       = event.action;
  const data         = notification.data || {};

  notification.close();

  // Decline button on call notification
  if (data.type === 'call' && action === 'decline') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'DECLINE_CALL_FROM_NOTIFICATION', callerID: data.callerID })
        );
      })
    );
    return;
  }

  if (action === 'close') return;

  const targetURL = data.url || '/chats.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing matching window
      for (const client of clients) {
        const clientURL  = new URL(client.url);
        const targetPath = new URL(targetURL, self.location.origin);
        if (clientURL.pathname === targetPath.pathname &&
            clientURL.searchParams.get('id') === targetPath.searchParams.get('id')) {
          return client.focus();
        }
      }
      // Navigate any open window
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'navigate' in client) {
          return client.navigate(targetURL).then(c => c && c.focus());
        }
      }
      // Open fresh window
      return self.clients.openWindow(targetURL);
    })
  );
});
