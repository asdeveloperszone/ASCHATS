/**
 * storage.js — Unified offline-first storage for ASChat
 * 
 * localStorage  → text messages, contacts, metadata (fast, ~5MB limit)
 * IndexedDB     → photos & audio as blobs (large, persistent, unlimited-ish)
 */

const DB_NAME    = 'aschat_db';
const DB_VERSION = 1;
const STORE_MEDIA = 'media'; // key: msgID, value: { blob, type }

let _db = null;

// ─── OPEN INDEXEDDB ──────────────────────────────────────────────────────────
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_MEDIA)) {
        db.createObjectStore(STORE_MEDIA, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ─── SAVE MEDIA (photo or audio base64) ─────────────────────────────────────
export async function saveMedia(msgID, base64DataURL, mediaType) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MEDIA, 'readwrite');
      tx.objectStore(STORE_MEDIA).put({ id: msgID, data: base64DataURL, type: mediaType });
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(e.target.error);
    });
  } catch (err) {
    console.error('saveMedia error:', err);
  }
}

// ─── GET MEDIA ───────────────────────────────────────────────────────────────
export async function getMedia(msgID) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx  = db.transaction(STORE_MEDIA, 'readonly');
      const req = tx.objectStore(STORE_MEDIA).get(msgID);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror   = () => resolve(null);
    });
  } catch (err) {
    return null;
  }
}

// ─── DELETE MEDIA ────────────────────────────────────────────────────────────
export async function deleteMedia(msgID) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_MEDIA, 'readwrite');
      tx.objectStore(STORE_MEDIA).delete(msgID);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch (err) {}
}

// ─── SAVE TEXT MESSAGE TO LOCALSTORAGE (no binary data) ─────────────────────
export function saveTextMessage(chatKey, msg) {
  try {
    // Strip binary data — store reference only
    const safe = {
      id:          msg.id,
      msgType:     msg.msgType,
      text:        msg.text || null,
      senderID:    msg.senderID,
      receiverID:  msg.receiverID || null,
      status:      msg.status || 'sent',
      reactions:   msg.reactions || {},
      replyTo:     msg.replyTo || null,
      forwarded:   msg.forwarded || false,
      callType:    msg.callType || null,
      callStatus:  msg.callStatus || null,
      timestamp:   msg.timestamp || Date.now(),
      type:        msg.type,
      hasMedia:    (msg.msgType === 'photo' || msg.msgType === 'audio'), // flag only
      waveform:    msg.msgType === 'audio' ? (msg.waveform || null) : null,
    };

    let messages = getLocalMessages(chatKey);
    if (!messages.find(m => m.id === safe.id)) {
      messages.push(safe);
      // Keep last 500 messages per chat to avoid quota issues
      if (messages.length > 500) messages = messages.slice(-500);
      setLocalMessages(chatKey, messages);
    }
  } catch (err) {
    console.error('saveTextMessage error:', err);
  }
}

// ─── UPDATE MESSAGE STATUS IN LOCALSTORAGE ───────────────────────────────────
export function updateLocalMessageStatus(chatKey, msgID, status) {
  try {
    const messages = getLocalMessages(chatKey);
    const idx = messages.findIndex(m => m.id === msgID);
    if (idx !== -1) {
      messages[idx].status = status;
      setLocalMessages(chatKey, messages);
    }
  } catch (err) {}
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
export function getLocalMessages(chatKey) {
  try {
    return JSON.parse(localStorage.getItem('chat_' + chatKey) || '[]');
  } catch { return []; }
}

export function setLocalMessages(chatKey, messages) {
  try {
    localStorage.setItem('chat_' + chatKey, JSON.stringify(messages));
  } catch (err) {
    // Quota exceeded — trim oldest 100 and retry
    if (messages.length > 100) {
      try {
        localStorage.setItem('chat_' + chatKey, JSON.stringify(messages.slice(-200)));
      } catch {}
    }
  }
}

// ─── OFFLINE SEND QUEUE ──────────────────────────────────────────────────────
const QUEUE_KEY = 'aschat_send_queue';

export function enqueueMessage(chatKey, payload) {
  try {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    queue.push({ chatKey, payload, queuedAt: Date.now() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {}
}

export function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch { return []; }
}

export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY);
}

export function removeFromQueue(queuedAt) {
  try {
    const queue = getQueue().filter(q => q.queuedAt !== queuedAt);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {}
}
