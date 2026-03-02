/**
 * sw.js — ASChat Service Worker
 * Handles: caching (offline-first) + all push notifications
 *
 * Re-engagement notification (WhatsApp "you may have new messages"):
 *   • Uses periodicsync (PWA installed) — fires every ~hour in background
 *   • Uses sync event — fires when device comes back online
 *   • Checks if user has unread messages and hasn't opened app recently
 *   • Shows once per quiet period — never spams
 */

const CACHE_NAME = 'aschat-v4';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/auth.html',
  '/chats.html',
  '/chat.html',
  '/profile.html',
  '/other-profile.html',
  '/css/style.css',
  '/manifest.json',
  '/js/auth.js',
  '/js/chat.js',
  '/js/chats.js',
  '/js/call.js',
  '/js/global-call.js',
  '/js/profile.js',
  '/js/other-profile.js',
  '/js/pwa.js',
  '/js/storage.js',
  '/js/firebase-config.js',
  '/js/notifications.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css'
];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('SW: failed to cache', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  if (url.includes('firebaseio.com') || url.includes('googleapis.com/identitytoolkit')) return;
  if (url.includes('gstatic.com/firebasejs')) return;
  if (url.includes('firebase') && url.includes('api')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.destination === 'document') {
            return caches.match('/chats.html');
          }
        })
      )
  );
});

// ─── MESSAGE FROM PAGE ────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  switch (data.type) {
    case 'NOTIFY_MESSAGE':      showMessageNotification(data);   break;
    case 'NOTIFY_CALL':         showCallNotification(data);      break;
    case 'DISMISS_CALL':        dismissCallNotification(data.callerID); break;
    case 'NOTIFY_MISSED_CALL':  showMissedCallNotification(data); break;
    case 'NOTIFY_REACTION':     showReactionNotification(data);  break;
    case 'CLEAR_NOTIFICATIONS': clearNotificationsForChat(data.otherID); break;

    // Page tells SW the current unread state + last active time
    case 'UPDATE_UNREAD_STATE':
      swState.totalUnread   = data.totalUnread   || 0;
      swState.unreadChats   = data.unreadChats   || [];
      swState.lastActiveAt  = data.lastActiveAt  || swState.lastActiveAt; // use page value, not SW time
      swState.userName      = data.userName      || '';
      persistState(); // survive SW restarts
      break;

    // Page tells SW user just opened the app — reset re-engagement timer
    case 'USER_ACTIVE':
      swState.lastActiveAt           = Date.now();
      swState.lastReengagementShown  = 0;
      persistState();
      cancelReengagementNotification();
      break;
  }
});

// ─── SW STATE ─────────────────────────────────────────────────────────────────
// In-memory cache — fast reads. Persisted to Cache API so it survives SW restarts.
// Without Cache API persistence, periodicsync would always see totalUnread=0
// because the SW is killed between syncs and in-memory state is wiped.
const swState = {
  totalUnread:          0,
  unreadChats:          [],
  lastActiveAt:         0,
  lastReengagementShown: 0,
  userName:             ''
};

const STATE_CACHE = 'aschat-sw-state-v1';
const STATE_URL   = '/__sw_state__'; // fake URL used as cache key

async function persistState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const body  = JSON.stringify({
      totalUnread:          swState.totalUnread,
      unreadChats:          swState.unreadChats,
      lastActiveAt:         swState.lastActiveAt,
      lastReengagementShown: swState.lastReengagementShown,
      userName:             swState.userName
    });
    await cache.put(STATE_URL, new Response(body, {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) {}
}

async function restoreState() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const res   = await cache.match(STATE_URL);
    if (!res) return;
    const saved = await res.json();
    Object.assign(swState, saved);
  } catch (e) {}
}

// ─── PERIODIC SYNC ────────────────────────────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'aschat-reengagement') {
    event.waitUntil(restoreState().then(() => maybeShowReengagement()));
  }
});

// ─── BACKGROUND SYNC ─────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'aschat-reengagement') {
    event.waitUntil(restoreState().then(() => maybeShowReengagement()));
  }
});

// ─── RE-ENGAGEMENT LOGIC ──────────────────────────────────────────────────────

const REENGAGEMENT_MIN_AWAY_MS  = 15 * 60 * 1000;  // Must be away 15+ min
const REENGAGEMENT_COOLDOWN_MS  = 60 * 60 * 1000;  // Max once per hour
const REENGAGEMENT_TAG          = 'reengagement';

async function maybeShowReengagement() {
  // Check if any app window is open and visible — don't notify if user is active
  const appOpen = await isAppOpen();
  if (appOpen) return;

  const now = Date.now();

  // Don't show if user was active recently
  if (swState.lastActiveAt && (now - swState.lastActiveAt) < REENGAGEMENT_MIN_AWAY_MS) return;

  // Don't spam — respect cooldown
  if (swState.lastReengagementShown && (now - swState.lastReengagementShown) < REENGAGEMENT_COOLDOWN_MS) return;

  // Only show if there are actual unread messages
  if (swState.totalUnread <= 0) return;

  // Don't show if a real message notification is already visible
  const existing = await self.registration.getNotifications();
  const hasRealNotif = existing.some(n => n.tag && (n.tag.startsWith('msg-') || n.tag.startsWith('call-')));
  if (hasRealNotif) return;

  swState.lastReengagementShown = now;
  await persistState();
  await showReengagementNotification();
}

async function showReengagementNotification() {
  const total  = swState.totalUnread;
  const chats  = swState.unreadChats || [];

  // Build smart body text — exactly like WhatsApp
  let title = 'ASChat';
  let body  = '';

  if (chats.length === 1) {
    // Single sender: "John: 3 unread messages"
    title = `ASChat — ${chats[0].name}`;
    body  = total === 1
      ? 'You have 1 unread message'
      : `You have ${total} unread messages`;
  } else if (chats.length === 2) {
    // Two senders: "John and Sarah sent you messages"
    title = 'ASChat';
    body  = `${chats[0].name} and ${chats[1].name} sent you messages`;
  } else if (chats.length > 2) {
    // Many: "John, Sarah and 2 others sent you messages"
    const others = chats.length - 2;
    body = `${chats[0].name}, ${chats[1].name} and ${others} other${others > 1 ? 's' : ''} sent you messages`;
  } else {
    body = `You have ${total} unread message${total > 1 ? 's' : ''}`;
  }

  await self.registration.showNotification(title, {
    body,
    icon:      chats.length === 1 && chats[0].photo ? chats[0].photo : '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       REENGAGEMENT_TAG,
    renotify:  false,   // Don't vibrate again if already showing
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: Date.now(),
    data: {
      type: 'reengagement',
      url:  '/chats.html'
    },
    actions: [
      { action: 'open',    title: '💬 Open ASChat' },
      { action: 'dismiss', title: '✕ Dismiss'      }
    ]
  });
}

function cancelReengagementNotification() {
  self.registration.getNotifications({ tag: REENGAGEMENT_TAG })
    .then(notifs => notifs.forEach(n => n.close()))
    .catch(() => {});
}

// ─── SHOW: MESSAGE NOTIFICATION ───────────────────────────────────────────────

async function showMessageNotification(data) {
  const { senderName, senderID, text, senderPhoto, timestamp } = data;

  const focused = await isClientFocusedOnChat(senderID);
  if (focused) return;

  // Close any re-engagement notification — a real message takes priority
  const reengagements = await self.registration.getNotifications({ tag: REENGAGEMENT_TAG });
  reengagements.forEach(n => n.close());

  await self.registration.showNotification(`ASChat — ${senderName}`, {
    body:      text,
    icon:      senderPhoto || '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       'msg-' + senderID,
    renotify:  true,
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: timestamp || Date.now(),
    data: {
      type: 'message',
      senderID,
      senderName,
      url: `/chat.html?id=${senderID}&name=${encodeURIComponent(senderName)}`
    },
    actions: [
      { action: 'open',  title: '💬 Open'    },
      { action: 'close', title: '✕ Dismiss'  }
    ]
  });
}

// ─── SHOW: CALL NOTIFICATION ──────────────────────────────────────────────────

async function showCallNotification(data) {
  const { callerName, callerID, callType, callerPhoto, timestamp } = data;
  const icon  = callType === 'video' ? '📹' : '📞';
  const label = callType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call';

  await self.registration.showNotification(`ASChat — ${callerName}`, {
    body:               `${icon} ${label}`,
    icon:               callerPhoto || '/icons/icon-192.png',
    badge:              '/icons/icon-192.png',
    tag:                'call-' + callerID,
    renotify:           true,
    requireInteraction: true,
    silent:             false,
    vibrate:            [500, 200, 500, 200, 500],
    timestamp:          timestamp || Date.now(),
    data: {
      type: 'call',
      callerID,
      callerName,
      callType,
      url: `/chat.html?id=${callerID}&name=${encodeURIComponent(callerName)}&autocall=accept&calltype=${callType}`
    },
    actions: [
      { action: 'accept',  title: '✅ Accept'  },
      { action: 'decline', title: '❌ Decline' }
    ]
  });
}

// ─── DISMISS CALL NOTIFICATION ────────────────────────────────────────────────

async function dismissCallNotification(callerID) {
  const notifs = await self.registration.getNotifications({ tag: 'call-' + callerID });
  notifs.forEach(n => n.close());
}

// ─── SHOW: MISSED CALL NOTIFICATION ──────────────────────────────────────────

async function showMissedCallNotification(data) {
  const { callerName, callerID, callType, callerPhoto, timestamp } = data;
  const icon = callType === 'video' ? '📹' : '📞';

  await self.registration.showNotification(`ASChat — Missed call from ${callerName}`, {
    body:      `${icon} Missed ${callType} call`,
    icon:      callerPhoto || '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       'missed-' + callerID,
    renotify:  true,
    silent:    false,
    vibrate:   [200, 100, 200],
    timestamp: timestamp || Date.now(),
    data: {
      type:       'message',
      senderID:   callerID,
      senderName: callerName,
      url:        `/chat.html?id=${callerID}&name=${encodeURIComponent(callerName)}`
    },
    actions: [
      { action: 'open',  title: '💬 Open Chat' },
      { action: 'close', title: '✕ Dismiss'    }
    ]
  });
}

// ─── SHOW: REACTION NOTIFICATION ─────────────────────────────────────────────

async function showReactionNotification(data) {
  const { senderName, senderID, emoji, senderPhoto, timestamp } = data;

  const focused = await isClientFocusedOnChat(senderID);
  if (focused) return;

  await self.registration.showNotification(`ASChat — ${senderName}`, {
    body:      `Reacted ${emoji} to your message`,
    icon:      senderPhoto || '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       'reaction-' + senderID,
    renotify:  true,
    silent:    true,
    vibrate:   [100],
    timestamp: timestamp || Date.now(),
    data: {
      type:       'message',
      senderID,
      senderName,
      url:        `/chat.html?id=${senderID}&name=${encodeURIComponent(senderName)}`
    },
    actions: [
      { action: 'open',  title: '💬 Open'   },
      { action: 'close', title: '✕ Dismiss' }
    ]
  });
}

// ─── CLEAR NOTIFICATIONS FOR A CHAT ──────────────────────────────────────────

async function clearNotificationsForChat(otherID) {
  const tags = ['msg-' + otherID, 'missed-' + otherID, 'reaction-' + otherID];
  for (const tag of tags) {
    const notifs = await self.registration.getNotifications({ tag });
    notifs.forEach(n => n.close());
  }
}

// ─── NOTIFICATION CLICK ───────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const action       = event.action;
  const data         = notification.data || {};

  notification.close();

  // Decline button on call
  if (data.type === 'call' && action === 'decline') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients =>
        clients.forEach(c => c.postMessage({ type: 'DECLINE_CALL_FROM_NOTIFICATION', callerID: data.callerID }))
      )
    );
    return;
  }

  if (action === 'close' || action === 'dismiss') return;

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

// ─── NOTIFICATION CLOSE ───────────────────────────────────────────────────────
self.addEventListener('notificationclose', () => {});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function isAppOpen() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    return clients.some(c => c.visibilityState === 'visible');
  } catch (e) { return false; }
}

async function isClientFocusedOnChat(otherID) {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      if (!client.focused) continue;
      const url = new URL(client.url);
      if (url.pathname.includes('chat.html') && url.searchParams.get('id') === String(otherID)) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}
