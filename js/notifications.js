/**
 * notifications.js — WhatsApp-style notifications for ASChat (PWA-compatible)
 *
 * TWO-LAYER ARCHITECTURE:
 *
 * Layer 1 — SW postMessage (app open / tab backgrounded)
 *   The page posts events to sw.js which shows OS notifications.
 *   Works when: tab open but backgrounded, screen on, browser open.
 *
 * Layer 2 — Firebase Cloud Messaging / FCM (app fully closed)
 *   Firebase server pushes to the device via FCM.
 *   firebase-messaging-sw.js wakes and shows the notification.
 *   Works when: browser closed, phone locked, PWA not running at all.
 *
 * This file handles:
 *   • Requesting notification permission
 *   • Getting & storing the FCM device token in Firebase DB
 *   • Token rotation (FCM tokens expire — we refresh automatically)
 *   • Handling foreground FCM messages (app IS open — Firebase suppresses them
 *     by default, so we re-route through SW)
 *   • All notification trigger functions used by other JS modules
 */

import { db } from './firebase-config.js';
import { ref, set, remove as dbRemove }
  from 'https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js';

// ─── VAPID KEY ─────────────────────────────────────────────────────────────────
//
// ⚠️  ONE-TIME SETUP:
// 1. Firebase Console → Project Settings → Cloud Messaging
// 2. Under "Web configuration" → "Web Push certificates" → Generate key pair
// 3. Paste the public key below.
//
// Without this, FCM token registration will fail silently and push won't work
// when the PWA/browser is fully closed. Everything else still works.
//
const VAPID_KEY = 'BB_cTMRtk43JFMaq056XWq0jHdOnTkMXUBBDqqy-TtK-VQixzJ6Sx5iXhlFn8Z7tFBq-sOgfAjfX2UR2iuXvBas';

// ─── LAZY FCM INSTANCE ────────────────────────────────────────────────────────
let _messaging  = null;
let _onMsgUnsub = null;
let _getToken   = null; // cached from getMessaging() to avoid re-importing

async function getMessaging() {
  if (_messaging) return _messaging;
  try {
    const { getApps }    = await import('https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js');
    const fcmModule      = await import('https://www.gstatic.com/firebasejs/12.9.0/firebase-messaging.js');
    const apps = getApps();
    if (!apps.length) return null;
    _messaging = fcmModule.getMessaging(apps[0]);
    // Wire foreground handler exactly once — stored on module so getToken() can reuse
    if (!_onMsgUnsub) {
      _onMsgUnsub = fcmModule.onMessage(_messaging, handleForegroundFCM);
    }
    // Store getToken for use in registerFCMToken without re-importing
    _getToken = fcmModule.getToken;
    return _messaging;
  } catch (err) {
    console.warn('[Notif] FCM unavailable:', err.message);
    return null;
  }
}

// ─── PERMISSION + TOKEN SETUP ─────────────────────────────────────────────────

/**
 * Request notification permission and register FCM token.
 * Idempotent — safe to call on every login.
 */
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;

  let granted = Notification.permission === 'granted';

  if (!granted && Notification.permission !== 'denied') {
    try {
      granted = (await Notification.requestPermission()) === 'granted';
    } catch (err) {
      console.warn('[Notif] Permission error:', err);
      return false;
    }
  }

  if (granted) await registerFCMToken();
  return granted;
}

export function notificationsGranted() {
  return 'Notification' in window && Notification.permission === 'granted';
}

/**
 * Register FCM token and persist to DB: fcmTokens/{userID}/{tokenKey}
 * The Cloud Function reads this path to deliver background pushes.
 */
export async function registerFCMToken() {
  const myID = localStorage.getItem('aschat_userID');
  if (!myID || myID === 'null') return;

  if (VAPID_KEY === 'YOUR_VAPID_KEY_HERE') {
    console.warn(
      '[Notif] VAPID key not configured.\n' +
      'Background push (closed app) is disabled.\n' +
      'See js/notifications.js for setup instructions.'
    );
    return;
  }

  try {
    const messaging = await getMessaging(); // also sets _getToken
    if (!messaging || !_getToken) return;

    // Register the dedicated FCM service worker
    const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });

    const token = await _getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) { console.warn('[Notif] Empty FCM token'); return; }

    // Token key: short hash used as DB key (avoids forbidden chars in Firebase paths)
    const tokenKey = _tokenKey(token);
    await set(ref(db, `fcmTokens/${myID}/${tokenKey}`), {
      token,
      platform:  _platform(),
      updatedAt: Date.now()
    });

    localStorage.setItem('aschat_fcm_key', tokenKey);
    console.log('[Notif] FCM token registered ✓');

  } catch (err) {
    console.warn('[Notif] Token registration failed:', err.message);
  }
}

/**
 * Remove token on logout so stale devices don't get pushes.
 */
export async function unregisterFCMToken() {
  const myID     = localStorage.getItem('aschat_userID');
  const tokenKey = localStorage.getItem('aschat_fcm_key');
  if (!myID || !tokenKey) return;
  try {
    await dbRemove(ref(db, `fcmTokens/${myID}/${tokenKey}`));
    localStorage.removeItem('aschat_fcm_key');
  } catch (err) {
    console.warn('[Notif] Token unregister failed:', err);
  }
}

// ─── FOREGROUND FCM HANDLER ───────────────────────────────────────────────────
// Firebase suppresses notifications when app is open. We re-fire via SW.

function handleForegroundFCM(payload) {
  const data = payload.data || {};
  if (!data.type) return;

  // Suppress if user is actively viewing the relevant chat
  const relevantID = data.senderID || data.callerID;
  if (relevantID && isViewingChat(relevantID)) return;

  switch (data.type) {
    case 'message':
      sendToSW({ type: 'NOTIFY_MESSAGE',    ...data, timestamp: Date.now() }); break;
    case 'call':
      sendToSW({ type: 'NOTIFY_CALL',       ...data, timestamp: Date.now() }); break;
    case 'missed_call':
      sendToSW({ type: 'NOTIFY_MISSED_CALL',...data, timestamp: Date.now() }); break;
    case 'reaction':
      sendToSW({ type: 'NOTIFY_REACTION',   ...data, timestamp: Date.now() }); break;
  }
}

// ─── VISIBILITY HELPERS ───────────────────────────────────────────────────────

export function isAppVisible() {
  return document.visibilityState === 'visible';
}

export function isViewingChat(otherID) {
  if (!isAppVisible()) return false;
  const p = new URLSearchParams(window.location.search);
  return window.location.pathname.includes('chat.html') &&
         p.get('id') === String(otherID);
}

// ─── SW BRIDGE ────────────────────────────────────────────────────────────────

async function sendToSW(payload) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage(payload);
  } catch (err) {
    console.warn('[Notif] SW postMessage failed:', err);
  }
}

// ─── PUBLIC TRIGGER FUNCTIONS ─────────────────────────────────────────────────
// Called by chats.js, chat.js, global-call.js

export function notifyMessage(senderName, senderID, text, senderPhoto) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  sendToSW({ type: 'NOTIFY_MESSAGE', senderName, senderID, text, senderPhoto: senderPhoto || null, timestamp: Date.now() });
}

export function notifyPhoto(senderName, senderID, senderPhoto) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  sendToSW({ type: 'NOTIFY_MESSAGE', senderName, senderID, text: '📷 Photo', senderPhoto: senderPhoto || null, timestamp: Date.now() });
}

export function notifyVoice(senderName, senderID, senderPhoto) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  sendToSW({ type: 'NOTIFY_MESSAGE', senderName, senderID, text: '🎤 Voice message', senderPhoto: senderPhoto || null, timestamp: Date.now() });
}

export function notifyIncomingCall(callerName, callerID, callType, callerPhoto) {
  if (!notificationsGranted()) return;
  sendToSW({ type: 'NOTIFY_CALL', callerName, callerID, callType, callerPhoto: callerPhoto || null, timestamp: Date.now() });
}

export function dismissCallNotification(callerID) {
  sendToSW({ type: 'DISMISS_CALL', callerID });
}

export function notifyMissedCall(callerName, callerID, callType, callerPhoto) {
  if (!notificationsGranted()) return;
  sendToSW({ type: 'NOTIFY_MISSED_CALL', callerName, callerID, callType, callerPhoto: callerPhoto || null, timestamp: Date.now() });
}

export function notifyReaction(senderName, senderID, emoji, senderPhoto) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  sendToSW({ type: 'NOTIFY_REACTION', senderName, senderID, emoji, senderPhoto: senderPhoto || null, timestamp: Date.now() });
}

export function clearChatNotifications(otherID) {
  sendToSW({ type: 'CLEAR_NOTIFICATIONS', otherID });
}

// ─── PRIVATE HELPERS ─────────────────────────────────────────────────────────

function _tokenKey(token) {
  // Create a safe Firebase key from token (no special chars, max 30 chars)
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i);
    hash |= 0;
  }
  return 'tok_' + Math.abs(hash).toString(36);
}

function _platform() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua))         return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/windows/i.test(ua))          return 'windows';
  if (/mac/i.test(ua))              return 'mac';
  return 'web';
}

// ─── RE-ENGAGEMENT: PERIODIC SYNC REGISTRATION ───────────────────────────────
// Called once after permission granted. Registers the background periodic sync
// so the SW can fire "you may have new messages" even when app is closed.

export async function registerReengagementSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;

    // Periodic Background Sync — fires every ~hour on Android PWA
    if ('periodicSync' in reg) {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state === 'granted') {
        await reg.periodicSync.register('aschat-reengagement', {
          minInterval: 60 * 60 * 1000  // 1 hour minimum (browser may do less often)
        });
        console.log('[Notif] Periodic sync registered ✓');
      }
    }

    // Background Sync — fires when device comes back online (fallback)
    if ('sync' in reg) {
      await reg.sync.register('aschat-reengagement');
    }
  } catch (err) {
    console.warn('[Notif] Sync registration failed:', err.message);
  }
}

// ─── RE-ENGAGEMENT: PUSH UNREAD STATE TO SW ───────────────────────────────────
// Call this whenever unread counts change or page visibility changes.
// The SW uses this data to decide whether to show the re-engagement notification.

export function updateSWUnreadState(unreadCounts, contacts) {
  if (!('serviceWorker' in navigator)) return;

  // Build list of chats with unread messages
  const unreadChats = Object.entries(unreadCounts)
    .filter(([, count]) => count > 0)
    .map(([userID, count]) => {
      const contact = contacts[userID] || {};
      return {
        id:    userID,
        name:  contact.name  || 'Someone',
        photo: contact.photo || null,
        count
      };
    });

  const totalUnread = unreadChats.reduce((sum, c) => sum + c.count, 0);

  sendToSW({
    type:         'UPDATE_UNREAD_STATE',
    totalUnread,
    unreadChats,
    lastActiveAt: Date.now(),
    userName:     localStorage.getItem('aschat_name') || ''
  });
}

// ─── RE-ENGAGEMENT: SIGNAL USER IS ACTIVE ────────────────────────────────────
// Call this when user opens the app / switches to the tab.
// Tells SW to reset its re-engagement timer and close any nudge notification.

export function signalUserActive() {
  sendToSW({ type: 'USER_ACTIVE' });
}
