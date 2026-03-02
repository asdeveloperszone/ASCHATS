import { notifyReaction, notifyMessage, notifyPhoto, notifyVoice, clearChatNotifications, signalUserActive } from './notifications.js';
import { auth, db } from './firebase-config.js';
import {
  saveTextMessage, saveMedia, getMedia, deleteMedia,
  getLocalMessages, setLocalMessages, updateLocalMessageStatus,
  enqueueMessage, getQueue, removeFromQueue
} from './storage.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { ref, push, onChildAdded, get, update, onValue, remove } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";
import {
  initCall,
  startCall as _startCall,
  acceptCall as _acceptCall,
  declineCall as _declineCall,
  endCall as _endCall,
  toggleMute as _toggleMute,
  toggleSpeaker as _toggleSpeaker,
  toggleCamera as _toggleCamera,
  flipCamera as _flipCamera,
  setOnline
} from './call.js';
// Note: declineCall, toggleSpeaker, and setOnline are now properly exported from call.js

// Get URL parameters
const params = new URLSearchParams(window.location.search);
const otherID = params.get('id');
const otherName = params.get('name');

// Global variables
let myID = null;
let myUID = null;
let chatKey = null;
let renderedIDs = new Set();
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let activeMessageID = null;
let activeMessageSenderID = null;
let replyTo = null;
let isOnline = navigator.onLine;
let forwardMessageData = null;
let analyserNode = null;
let animationFrameID = null;
const messageDataStore = {};
const speeds = [1, 1.5, 2];
const audioPlayers = {};
const audioSpeeds = {};
let waveformData = [];
let waveformBars = [];

// Check authentication
onAuthStateChanged(auth, async (user) => {
  if (!user) { 
    window.location.href = 'auth.html'; 
    return; 
  }
  
  myUID = user.uid;
  myID = localStorage.getItem('aschat_userID');
  
  if (!myID || myID === 'null') {
    // Try to load from Firebase
    try {
      const snapshot = await get(ref(db, 'userMap/' + myUID));
      if (snapshot.exists()) {
        myID = snapshot.val();
        localStorage.setItem('aschat_userID', myID);
      } else {
        console.error('No user ID found');
        window.location.href = 'auth.html';
        return;
      }
    } catch (err) {
      console.error('Error loading user ID:', err);
      window.location.href = 'auth.html';
      return;
    }
  }
  
  chatKey = getChatKey(myID, otherID);
  await setupHeader();
  loadMessagesFromLocal();
  syncFromFirebase();
  listenForNewMessages();
  markMessagesAsSeen();
  listenToTyping();
  setupTypingEmitter();
  initOfflineDetection();
  listenToStatusUpdates();
  listenToPresence();

  // 🔔 Clear any OS notifications for this chat now that user has opened it
  clearChatNotifications(otherID);

  // 🔔 Tell SW user is active — suppress re-engagement notification
  signalUserActive();

  // 🔔 Also signal active whenever user returns to this tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') signalUserActive();
  });

  // Initialize calls
  setOnline(myID);
  initCall(myID, otherID, otherName, () => {});

  // Auto-accept if arrived here from global incoming call popup
  const autoCallParam = new URLSearchParams(window.location.search).get('autocall');
  if (autoCallParam === 'accept') {
    // Delay slightly to ensure Firebase connection and call data are ready
    setTimeout(() => _acceptCall(), 2000);
  }
});

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────

function getChatKey(id1, id2) { 
  return [id1, id2].sort().join('_'); 
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function getTicks(status) {
  if (status === 'sending') {
    return `<span class="msg-ticks sending"><i class="fa-solid fa-clock"></i></span>`;
  }
  if (status === 'seen') {
    return `<span class="msg-ticks seen">✓✓</span>`;
  }
  if (status === 'delivered') {
    return `<span class="msg-ticks delivered">✓✓</span>`;
  }
  return `<span class="msg-ticks">✓</span>`;
}

function scrollToBottom() {
  const container = document.getElementById('messagesContainer');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

// ─── HEADER SETUP ────────────────────────────────────────────────

async function setupHeader() {
  document.getElementById('chatName').textContent = otherName;
  
  const avatar = document.getElementById('chatAvatar');
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[otherID];
  
  if (contact && contact.photo) {
    avatar.innerHTML = `<img src="${contact.photo}" class="chat-avatar-small-img" />`;
  } else {
    avatar.textContent = otherName.charAt(0).toUpperCase();
    
    try {
      const snap = await get(ref(db, 'users/' + otherID));
      if (snap.exists() && snap.val().photoURL) {
        avatar.innerHTML = `<img src="${snap.val().photoURL}" class="chat-avatar-small-img" />`;
        
        // Update contacts cache
        if (contact) {
          contact.photo = snap.val().photoURL;
          localStorage.setItem('aschat_contacts', JSON.stringify(contacts));
        }
      }
    } catch (err) { 
      console.error('Error loading avatar:', err); 
    }
  }
}

// ─── PRESENCE LISTENER ────────────────────────────────────────────────

function listenToPresence() {
  const presenceRef = ref(db, 'presence/' + otherID);
  onValue(presenceRef, (snapshot) => {
    const statusEl = document.getElementById('chatStatus');
    if (!statusEl) return;
    
    if (snapshot.exists() && snapshot.val() === 'online') {
      statusEl.textContent = 'online';
      statusEl.style.color = '#22C55E';
    } else {
      statusEl.textContent = 'offline';
      statusEl.style.color = 'var(--text-muted)';
    }
  });
}

// ─── CALL CONTROLS ─────────────────────────────────────────

window.openOtherProfile = function () {
  const backURL = encodeURIComponent('chat.html?id=' + otherID + '&name=' + encodeURIComponent(otherName));
  window.location.href = `other-profile.html?id=${otherID}&back=${backURL}`;
}

window.startCall = (type) => _startCall(type);
window.acceptCall = () => _acceptCall();
window.declineCall = () => _declineCall();
window.endCall = () => _endCall();
window.toggleMute = () => _toggleMute();
window.toggleSpeaker = () => _toggleSpeaker();
window.toggleCamera = () => _toggleCamera();
window.flipCamera = () => _flipCamera();

// ─── LOAD MESSAGES FROM LOCAL STORAGE ───────────────────────────────────────

async function loadMessagesFromLocal() {
  const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
  const messages = getLocalMessages(chatKey);

  for (const msg of messages) {
    if (deleted.includes(msg.id)) continue;
    if (renderedIDs.has(msg.id)) continue;

    // Load media from IndexedDB if needed
    if (msg.hasMedia) {
      const media = await getMedia(msg.id);
      if (media) {
        if (msg.msgType === 'photo') msg.photo = media.data;
        if (msg.msgType === 'audio') msg.audio = media.data;
      }
    }

    renderedIDs.add(msg.id);
    renderMessage(msg);
  }

  scrollToBottom();
}

// ─── SYNC FROM FIREBASE ────────────────────────────────────

async function syncFromFirebase() {
  try {
    const snapshot = await get(ref(db, 'messages/' + chatKey));
    if (!snapshot.exists()) return;
    
    const data = snapshot.val();
    const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
    const localIDs = new Set(getLocalMessages(chatKey).map(m => m.id));

    // FIX: Build message list WITHOUT photo/audio in memory first,
    // to avoid holding multiple MB of base64 strings simultaneously.
    const allMessages = Object.entries(data).map(([key, val]) => ({
      id: key,
      text: val.text || null,
      // FIX: Don't inline photo/audio here — we save to IndexedDB separately below
      // and load from there when rendering. Keeping base64 in allMessages array
      // causes massive memory usage (each photo = ~1-3MB × N messages).
      photo: null,
      audio: null,
      _rawPhoto: val.photo || null,  // temporary reference, cleared after save
      _rawAudio: val.audio || null,
      msgType: val.msgType || 'text',
      senderID: val.senderID,
      status: val.status || 'sent',
      reactions: val.reactions || {},
      replyTo: val.replyTo || null,
      forwarded: val.forwarded || false,
      waveform: val.waveform || null,
      callType: val.callType || null,
      callStatus: val.callStatus || null,
      timestamp: val.timestamp || Date.now(),
      type: val.senderID === myID ? 'sent' : 'received'
    }));

    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    for (const msg of allMessages) {
      if (deleted.includes(msg.id)) continue;

      // Save new messages to local storage + IndexedDB
      if (!localIDs.has(msg.id)) {
        // Save media to IndexedDB if present in Firebase
        if (msg.msgType === 'photo' && msg._rawPhoto) {
          await saveMedia(msg.id, msg._rawPhoto, 'photo');
        }
        if (msg.msgType === 'audio' && msg._rawAudio) {
          await saveMedia(msg.id, msg._rawAudio, 'audio');
        }
        // Save text metadata to localStorage (saveTextMessage strips binary)
        const msgForLocal = { ...msg };
        delete msgForLocal._rawPhoto;
        delete msgForLocal._rawAudio;
        saveTextMessage(chatKey, msgForLocal);
      }

      // Clear raw references from memory immediately after saving
      msg._rawPhoto = null;
      msg._rawAudio = null;

      if (!renderedIDs.has(msg.id)) {
        // Load media from IndexedDB for rendering
        if (msg.msgType === 'photo' || msg.msgType === 'audio') {
          const cached = await getMedia(msg.id);
          if (cached) {
            if (msg.msgType === 'photo') msg.photo = cached.data;
            if (msg.msgType === 'audio') msg.audio = cached.data;
          }
        }
        renderedIDs.add(msg.id);
        renderMessage(msg);

        // FIX: Clear photo/audio from msg object after rendering to free memory
        msg.photo = null;
        msg.audio = null;
      }
    }

    scrollToBottom();
  } catch (err) {
    console.error('Sync error:', err);
  }
}

// ─── LISTEN FOR NEW MESSAGES ───────────────────────────────

function listenForNewMessages() {
  // FIX: Use limitToLast approach instead of startAt(timestamp) which requires
  // a Firebase .indexOn rule to work correctly. Without the index, orderByChild
  // silently falls back to client filtering but onChildAdded may not fire reliably.
  // Instead, listen to the full path and rely on renderedIDs deduplication.
  const messagesRef = ref(db, 'messages/' + chatKey);
  const listenFromTime = Date.now();
  
  onChildAdded(messagesRef, async (snapshot) => {
    const msg = snapshot.val();
    const msgID = snapshot.key;
    
    if (!msg) return;

    // Skip messages that were already loaded by syncFromFirebase/loadMessagesFromLocal
    const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
    if (renderedIDs.has(msgID) || deleted.includes(msgID)) return;

    // FIX: Also skip old messages (before page load) that weren't caught by renderedIDs
    // This handles the case where syncFromFirebase hasn't finished yet
    if (msg.timestamp && msg.timestamp < listenFromTime - 5000) {
      // Old message not yet rendered — let syncFromFirebase handle it
      return;
    }

    const newMsg = {
      id: msgID,
      text: msg.text || null,
      audio: msg.audio || null,
      photo: msg.photo || null,
      msgType: msg.msgType || 'text',
      senderID: msg.senderID,
      status: msg.status || 'sent',
      reactions: msg.reactions || {},
      replyTo: msg.replyTo || null,
      forwarded: msg.forwarded || false,
      waveform: msg.waveform || null,
      callType: msg.callType || null,
      callStatus: msg.callStatus || null,
      timestamp: msg.timestamp || Date.now(),
      type: msg.senderID === myID ? 'sent' : 'received'
    };

    renderedIDs.add(msgID);
    
    // Update status for received messages
    if (newMsg.type === 'received' && newMsg.msgType !== 'call') {
      try {
        await update(ref(db, 'messages/' + chatKey + '/' + msgID), { 
          status: 'delivered' 
        });
        newMsg.status = 'delivered';
      } catch (err) {
        console.error('Error updating message status:', err);
      }
    }

    saveMessageToLocal(newMsg);
    renderMessage(newMsg);
    scrollToBottom();

    // 🔔 Notify if app is not visible (user on another tab/app)
    // chats.js also fires these, but chat.js covers the case where user is
    // IN this chat page but tab is hidden (e.g. phone screen off)
    if (newMsg.type === 'received' && newMsg.msgType !== 'call' && document.visibilityState !== 'visible') {
      const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
      const contact = contacts[otherID];
      const photo = contact ? contact.photo : null;
      if (newMsg.msgType === 'photo') {
        notifyPhoto(otherName, otherID, photo);
      } else if (newMsg.msgType === 'audio') {
        notifyVoice(otherName, otherID, photo);
      } else {
        notifyMessage(otherName, otherID, newMsg.text || '', photo);
      }
    }
  });
}

// ─── MARK MESSAGES AS SEEN ──────────────────────────────────────────

async function markMessagesAsSeen() {
  try {
    const snapshot = await get(ref(db, 'messages/' + chatKey));
    if (!snapshot.exists()) return;
    
    const data = snapshot.val();
    const updates = {};
    let hasUpdates = false;
    
    Object.entries(data).forEach(([key, val]) => {
      if (val.receiverID === myID && val.status !== 'seen') {
        updates[key + '/status'] = 'seen';
        hasUpdates = true;
      }
    });
    
    if (hasUpdates) {
      await update(ref(db, 'messages/' + chatKey), updates);
    }
    
    // Clear unread count
    let unread = JSON.parse(localStorage.getItem('aschat_unread') || '{}');
    unread[otherID] = 0;
    localStorage.setItem('aschat_unread', JSON.stringify(unread));
  } catch (err) { 
    console.error('Mark seen error:', err); 
  }
}

// ─── LIVE STATUS UPDATES ───────────────────────────────────

function listenToStatusUpdates() {
  const messagesRef = ref(db, 'messages/' + chatKey);
  // Track reactions we've already notified about (by msgID+reactorID+emoji)
  const notifiedReactions = new Set();

  onValue(messagesRef, (snapshot) => {
    if (!snapshot.exists()) return;
    // FIX: Only extract metadata — skip photo/audio base64 to avoid memory crash on mobile
    const rawData = snapshot.val();
    const data = {};
    Object.entries(rawData).forEach(([key, val]) => {
      data[key] = {
        senderID: val.senderID, receiverID: val.receiverID,
        status: val.status, reactions: val.reactions || {},
        msgType: val.msgType, text: val.text || null,
        callType: val.callType || null, callStatus: val.callStatus || null,
        timestamp: val.timestamp, replyTo: val.replyTo || null,
        forwarded: val.forwarded || false, waveform: val.waveform || null,
        // deliberately skip: photo, audio (large base64 — not needed for status updates)
      };
    });
    const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');

    document.querySelectorAll('[data-id]').forEach(el => {
      const msgID = el.getAttribute('data-id');
      
      if (!data[msgID]) {
        // Message was deleted
        let messages = JSON.parse(localStorage.getItem('chat_' + chatKey) || '[]');
        messages = messages.filter(m => m.id !== msgID);
        localStorage.setItem('chat_' + chatKey, JSON.stringify(messages));
        renderedIDs.delete(msgID);
        el.remove();
        return;
      }
      
      if (deleted.includes(msgID)) return;
      
      const val = data[msgID];

      // Update ticks
      if (val.senderID === myID) {
        const tickEl = el.querySelector('.msg-ticks');
        if (tickEl) {
          if (val.status === 'seen') { 
            tickEl.className = 'msg-ticks seen'; 
            tickEl.innerHTML = '✓✓';
          } else if (val.status === 'delivered') { 
            tickEl.className = 'msg-ticks delivered'; 
            tickEl.innerHTML = '✓✓';
          } else { 
            tickEl.className = 'msg-ticks'; 
            tickEl.innerHTML = '✓';
          }
        }

        // 🔔 Check for new reactions on MY messages from the other person
        if (val.reactions) {
          Object.entries(val.reactions).forEach(([reactorID, emoji]) => {
            if (reactorID === myID) return; // skip my own reactions
            const reactionKey = msgID + '_' + reactorID + '_' + emoji;
            if (!notifiedReactions.has(reactionKey)) {
              notifiedReactions.add(reactionKey);
              const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
              const contact = contacts[reactorID];
              const name = contact ? contact.name : otherName;
              const photo = contact ? contact.photo : null;
              notifyReaction(name, reactorID, emoji, photo);
            }
          });
        }
      }
      
      // Update reactions
      const reactionsEl = el.querySelector('.msg-reactions');
      if (reactionsEl) {
        reactionsEl.innerHTML = buildReactionsHTML(val.reactions || {});
      }
    });
  });
}

// ─── REACTIONS ─────────────────────────────────────────────

function buildReactionsHTML(reactions) {
  if (!reactions || Object.keys(reactions).length === 0) return '';
  
  const counts = {};
  let myReaction = null;
  
  Object.entries(reactions).forEach(([uid, emoji]) => {
    counts[emoji] = (counts[emoji] || 0) + 1;
    if (uid === myID) myReaction = emoji;
  });
  
  return Object.entries(counts).map(([emoji, count]) => `
    <span class="msg-reaction-badge ${myReaction === emoji ? 'mine' : ''}">
      ${emoji}<span class="count">${count > 1 ? count : ''}</span>
    </span>
  `).join('');
}

// ─── REPLY PREVIEW ─────────────────────────────────────────────────

function buildReplyHTML(replyTo) {
  if (!replyTo) return '';
  
  const senderLabel = replyTo.senderID === myID ? 'You' : otherName;
  let preview = '';
  
  if (replyTo.msgType === 'photo') {
    preview = '📷 Photo';
  } else if (replyTo.msgType === 'audio') {
    preview = '🎤 Voice message';
  } else {
    preview = replyTo.text || '';
  }
  
  return `<div class="reply-preview"><strong>${senderLabel}</strong> ${preview}</div>`;
}

// ─── WAVEFORM ──────────────────────────────────────────────

function buildWaveformHTML(waveformData) {
  if (!waveformData || waveformData.length === 0) {
    waveformData = Array.from({ length: 30 }, () => Math.random() * 0.8 + 0.1);
  }
  
  return waveformData.map((v, i) => {
    const h = Math.max(4, Math.round(v * 28));
    return `<div class="waveform-bar" data-index="${i}" style="height:${h}px;"></div>`;
  }).join('');
}

function sampleWaveform(data, maxPoints) {
  if (data.length <= maxPoints) return data;
  const step = data.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => data[Math.floor(i * step)]);
}

// ─── VOICE CARD ────────────────────────────────────────────

function renderVoiceCard(msg) {
  const waveHTML = buildWaveformHTML(msg.waveform || null);
  
  return `
    <div class="voice-card" id="voice_${msg.id}">
      <div class="voice-controls">
        <button class="voice-play-btn" id="playBtn_${msg.id}" onclick="togglePlay('${msg.id}')">
          <i class="fa-solid fa-play"></i>
        </button>
        <div class="waveform-container" id="waveform_${msg.id}">${waveHTML}</div>
      </div>
      <div class="voice-bottom-row">
        <span class="voice-duration" id="dur_${msg.id}">0:00</span>
        <button class="voice-speed-btn" id="speed_${msg.id}" onclick="cycleSpeed('${msg.id}')">1x</button>
      </div>
      <audio id="audio_${msg.id}" src="${msg.audio}" style="display:none;"></audio>
    </div>
  `;
}

// Voice playback functions (make them global)
window.togglePlay = function (msgID) {
  const audio = document.getElementById('audio_' + msgID);
  const btn = document.getElementById('playBtn_' + msgID);
  
  if (!audio) return;
  
  if (audio.paused) {
    // Pause any other playing audio
    Object.keys(audioPlayers).forEach(id => {
      if (id !== msgID) {
        audioPlayers[id].pause();
        const b = document.getElementById('playBtn_' + id);
        if (b) b.innerHTML = '<i class="fa-solid fa-play"></i>';
      }
    });
    
    audio.play();
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    audioPlayers[msgID] = audio;
    
    audio.ontimeupdate = () => updateWaveformProgress(msgID, audio);
    audio.onended = () => {
      btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      resetWaveform(msgID);
    };
  } else {
    audio.pause();
    btn.innerHTML = '<i class="fa-solid fa-play"></i>';
  }
}

function updateWaveformProgress(msgID, audio) {
  const dur = document.getElementById('dur_' + msgID);
  if (dur) {
    const t = audio.currentTime;
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60).toString().padStart(2, '0');
    dur.textContent = `${mins}:${secs}`;
  }
  
  const container = document.getElementById('waveform_' + msgID);
  if (!container || !audio.duration) return;
  
  const bars = container.querySelectorAll('.waveform-bar');
  const progress = audio.currentTime / audio.duration;
  const playedCount = Math.floor(progress * bars.length);
  
  bars.forEach((bar, i) => {
    bar.classList.toggle('played', i < playedCount);
  });
}

function resetWaveform(msgID) {
  const container = document.getElementById('waveform_' + msgID);
  if (container) {
    container.querySelectorAll('.waveform-bar').forEach(b => b.classList.remove('played'));
  }
  const dur = document.getElementById('dur_' + msgID);
  if (dur) dur.textContent = '0:00';
}

window.cycleSpeed = function (msgID) {
  const audio = document.getElementById('audio_' + msgID);
  const btn = document.getElementById('speed_' + msgID);
  
  if (!audio || !btn) return;
  
  const currentIdx = audioSpeeds[msgID] || 0;
  const nextIdx = (currentIdx + 1) % speeds.length;
  audioSpeeds[msgID] = nextIdx;
  audio.playbackRate = speeds[nextIdx];
  btn.textContent = speeds[nextIdx] + 'x';
}

// ─── SENDING PLACEHOLDER ───────────────────────────────────

function renderSendingPlaceholder(type, tempID) {
  const container = document.getElementById('messagesContainer');
  const wrapper = document.createElement('div');
  wrapper.className = 'message-wrapper sent';
  wrapper.setAttribute('data-temp-id', tempID);

  const bubble = document.createElement('div');
  bubble.className = 'message sent';

  if (type === 'photo') {
    bubble.innerHTML = `
      <div class="sending-placeholder photo-placeholder">
        <div class="sending-spinner"></div>
        <span>Sending photo...</span>
      </div>
      <div class="msg-meta">
        <span class="msg-time">${formatTime(Date.now())}</span>
        ${getTicks('sending')}
      </div>`;
  } else if (type === 'audio') {
    const fakeBars = Array.from({ length: 30 }, () =>
      `<div class="waveform-bar sending-wave-bar" style="height:${Math.max(4, Math.round(Math.random() * 28))}px;"></div>`
    ).join('');
    
    bubble.innerHTML = `
      <div class="voice-card">
        <div class="voice-controls">
          <button class="voice-play-btn" disabled style="opacity:0.5;">
            <i class="fa-solid fa-play"></i>
          </button>
          <div class="waveform-container sending-waveform">${fakeBars}</div>
        </div>
        <div class="voice-bottom-row">
          <span class="voice-duration" style="display:flex;align-items:center;gap:6px;">
            <span class="sending-spinner" style="width:12px;height:12px;border-width:2px;"></span>
            Sending...
          </span>
        </div>
      </div>
      <div class="msg-meta">
        <span class="msg-time">${formatTime(Date.now())}</span>
        ${getTicks('sending')}
      </div>`;
  }

  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  scrollToBottom();
}

function removeSendingPlaceholder(tempID) {
  const el = document.querySelector(`[data-temp-id="${tempID}"]`);
  if (el) el.remove();
}

// ─── BOTTOM SHEET ──────────────────────────────────────────

window.openBottomSheet = function (msgID) {
  const msg = messageDataStore[msgID];
  if (!msg) return;
  
  activeMessageID = msgID;
  activeMessageSenderID = msg.senderID;

  // Highlight selected reaction
  const spans = document.getElementById('reactionPicker').querySelectorAll('span');
  spans.forEach(s => s.classList.remove('selected'));
  
  get(ref(db, 'messages/' + chatKey + '/' + msgID + '/reactions/' + myID)).then(snap => {
    if (snap.exists()) {
      spans.forEach(s => { 
        if (s.textContent.trim() === snap.val()) {
          s.classList.add('selected');
        }
      });
    }
  });

  // Build action buttons
  const actions = document.getElementById('sheetActions');
  actions.innerHTML = '';

  if (msg.msgType !== 'call') {
    const replyBtn = document.createElement('button');
    replyBtn.className = 'sheet-btn';
    replyBtn.innerHTML = `<i class="fa-solid fa-reply"></i> Reply`;
    replyBtn.onclick = () => startReply(msg);
    actions.appendChild(replyBtn);

    const forwardBtn = document.createElement('button');
    forwardBtn.className = 'sheet-btn';
    forwardBtn.innerHTML = `<i class="fa-solid fa-share"></i> Forward`;
    forwardBtn.onclick = () => startForward(msg);
    actions.appendChild(forwardBtn);
  }

  const deleteMe = document.createElement('button');
  deleteMe.className = 'sheet-btn danger';
  deleteMe.innerHTML = `<i class="fa-solid fa-trash"></i> Delete for me`;
  deleteMe.onclick = () => deleteForMe(msgID);
  actions.appendChild(deleteMe);

  if (msg.senderID === myID) {
    const deleteAll = document.createElement('button');
    deleteAll.className = 'sheet-btn danger';
    deleteAll.innerHTML = `<i class="fa-solid fa-trash-can"></i> Delete for everyone`;
    deleteAll.onclick = () => deleteForEveryone(msgID);
    actions.appendChild(deleteAll);
  }

  document.getElementById('bottomSheet').style.display = 'flex';
}

window.closeBottomSheet = function () {
  document.getElementById('bottomSheet').style.display = 'none';
  activeMessageID = null;
  activeMessageSenderID = null;
}

window.closeSheet = function (e) {
  if (e.target === document.getElementById('bottomSheet')) {
    closeBottomSheet();
  }
}

window.reactToMessage = async function (emoji) {
  if (!activeMessageID) return;
  
  try {
    const reactionRef = ref(db, 'messages/' + chatKey + '/' + activeMessageID + '/reactions/' + myID);
    const snap = await get(reactionRef);
    
    if (snap.exists() && snap.val() === emoji) {
      await remove(reactionRef);
    } else {
      await update(ref(db, 'messages/' + chatKey + '/' + activeMessageID + '/reactions'), { 
        [myID]: emoji 
      });

      // 🔔 Notify the other person about the reaction (only when reacting, not removing)
      // Only notify if we're reacting to THEIR message
      const msg = messageDataStore[activeMessageID];
      if (msg && msg.senderID !== myID) {
        const myName = localStorage.getItem('aschat_name') || 'Someone';
        const myPhoto = localStorage.getItem('aschat_photo') || null;
        // We notify via the other person's client — this fires from our side,
        // so we don't call notifyReaction here (we're not the receiver).
        // Reaction notifications for the other person are handled by their
        // listenToStatusUpdates() seeing the new reaction data.
      }
    }
  } catch (err) { 
    console.error('Reaction error:', err); 
  }
  
  closeBottomSheet();
}

// ─── REPLY ─────────────────────────────────────────────────

function startReply(msg) {
  replyTo = { 
    msgID: msg.id, 
    senderID: msg.senderID, 
    text: msg.text, 
    msgType: msg.msgType 
  };
  
  const senderLabel = msg.senderID === myID ? 'You' : otherName;
  let preview = '';
  
  if (msg.msgType === 'photo') {
    preview = '📷 Photo';
  } else if (msg.msgType === 'audio') {
    preview = '🎤 Voice message';
  } else {
    preview = msg.text || '';
  }
  
  document.getElementById('replyBarName').textContent = senderLabel;
  document.getElementById('replyBarText').textContent = preview;
  document.getElementById('replyBar').classList.add('active');
  document.getElementById('messageInput').focus();
  closeBottomSheet();
}

window.cancelReply = function () {
  replyTo = null;
  document.getElementById('replyBar').classList.remove('active');
}

// ─── FORWARD ───────────────────────────────────────────────

function startForward(msg) {
  forwardMessageData = msg;
  
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const list = document.getElementById('forwardContactsList');
  list.innerHTML = '';
  
  const others = Object.values(contacts).filter(c => c.userID !== otherID);
  
  if (others.length === 0) {
    list.innerHTML = '<p style="color:#aaa;text-align:center;font-size:13px;padding:20px 0;">No other contacts.</p>';
  } else {
    others.forEach(contact => {
      const item = document.createElement('div');
      item.className = 'forward-contact';
      
      const avatarHTML = contact.photo
        ? `<img src="${contact.photo}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" />`
        : `<div class="forward-avatar">${contact.name.charAt(0).toUpperCase()}</div>`;
      
      item.innerHTML = `${avatarHTML}<span class="forward-contact-name">${contact.name}</span>`;
      item.onclick = () => forwardToContact(contact);
      list.appendChild(item);
    });
  }
  
  closeBottomSheet();
  document.getElementById('forwardModal').style.display = 'flex';
}

window.closeForwardModal = function () {
  document.getElementById('forwardModal').style.display = 'none';
  forwardMessageData = null;
}

async function forwardToContact(contact) {
  if (!forwardMessageData) return;
  
  const fwdChatKey = getChatKey(myID, contact.userID);
  
  try {
    const payload = {
      msgType: forwardMessageData.msgType,
      senderID: myID,
      receiverID: contact.userID,
      status: 'sent',
      timestamp: Date.now(),
      forwarded: true
    };
    
    if (forwardMessageData.msgType === 'photo') {
      payload.photo = forwardMessageData.photo;
    } else if (forwardMessageData.msgType === 'audio') {
      payload.audio = forwardMessageData.audio;
      payload.waveform = forwardMessageData.waveform || null;
    } else {
      payload.text = forwardMessageData.text;
    }

    const newRef = await push(ref(db, 'messages/' + fwdChatKey), payload);
    
    const fwdMsg = { 
      ...payload, 
      id: newRef.key, 
      type: 'sent' 
    };
    
    let fwdMessages = JSON.parse(localStorage.getItem('chat_' + fwdChatKey) || '[]');
    fwdMessages.push(fwdMsg);
    localStorage.setItem('chat_' + fwdChatKey, JSON.stringify(fwdMessages));

    let contacts2 = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
    if (!contacts2[contact.userID]) {
      contacts2[contact.userID] = { 
        name: contact.name, 
        userID: contact.userID,
        photo: contact.photo || null
      };
      localStorage.setItem('aschat_contacts', JSON.stringify(contacts2));
    }
    
    closeForwardModal();
    alert(`Message forwarded to ${contact.name}!`);
  } catch (err) { 
    console.error('Forward error:', err);
    alert('Failed to forward message.'); 
  }
}

// ─── DELETE ────────────────────────────────────────────────

async function deleteForMe(msgID) {
  let deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
  if (!deleted.includes(msgID)) {
    deleted.push(msgID);
    localStorage.setItem('deleted_forme_' + chatKey, JSON.stringify(deleted));
  }

  let messages = getLocalMessages(chatKey);
  messages = messages.filter(m => m.id !== msgID);
  setLocalMessages(chatKey, messages);
  await deleteMedia(msgID);

  renderedIDs.delete(msgID);
  const el = document.querySelector(`[data-id="${msgID}"]`);
  if (el) el.remove();

  closeBottomSheet();
}

async function deleteForEveryone(msgID) {
  try {
    await remove(ref(db, 'messages/' + chatKey + '/' + msgID));
    
    let messages = JSON.parse(localStorage.getItem('chat_' + chatKey) || '[]');
    messages = messages.filter(m => m.id !== msgID);
    localStorage.setItem('chat_' + chatKey, JSON.stringify(messages));
    
    renderedIDs.delete(msgID);
    const el = document.querySelector(`[data-id="${msgID}"]`);
    if (el) el.remove();
  } catch (err) { 
    console.error('Delete everyone error:', err); 
  }
  
  closeBottomSheet();
}

// ─── SEND TEXT ─────────────────────────────────────────────

window.sendMessage = async function () {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();

  if (!text) return;
  input.value = '';

  const payload = {
    text,
    msgType: 'text',
    senderID: myID,
    receiverID: otherID,
    status: 'sent',
    timestamp: Date.now()
  };

  if (replyTo) {
    payload.replyTo = replyTo;
    cancelReply();
  }

  // Optimistic UI — show immediately with a temp ID
  const tempID = 'pending_' + Date.now();
  const optimisticMsg = { ...payload, id: tempID, type: 'sent', status: 'sending' };
  renderedIDs.add(tempID);
  renderMessage(optimisticMsg);
  scrollToBottom();

  if (!isOnline) {
    // Queue for later and save locally with temp ID
    enqueueMessage(chatKey, payload);
    saveMessageToLocal(optimisticMsg);
    return;
  }

  try {
    const newRef = await push(ref(db, 'messages/' + chatKey), payload);
    const realID = newRef.key;

    // Register real ID in renderedIDs BEFORE anything else
    // so syncFromFirebase / onChildAdded both skip it
    renderedIDs.add(realID);

    // Update the temp bubble in-place (swap ID + tick) — no remove+re-render
    const tempEl = document.querySelector('[data-id="' + tempID + '"]');
    if (tempEl) {
      tempEl.setAttribute('data-id', realID);
      const ticks = tempEl.querySelector('.msg-ticks');
      if (ticks) ticks.outerHTML = '<span class="msg-ticks">✓</span>';
    }

    renderedIDs.delete(tempID);

    const msg = { ...payload, id: realID, type: 'sent' };
    saveMessageToLocal(msg);
  } catch (err) {
    console.error('Send error:', err);
    // Mark as failed in UI
    const el = document.querySelector('[data-id="' + tempID + '"]');
    if (el) el.classList.add('msg-failed');
  }
}

// ─── SEND PHOTO ────────────────────────────────────────────

window.sendPhoto = async function (event) {
  const file = event.target.files[0];
  if (!file) return;
  
  // Validate file size (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    alert('Photo too large. Max 5MB.');
    return;
  }
  
  const tempID = 'temp_' + Date.now();
  renderSendingPlaceholder('photo', tempID);
  
  const reader = new FileReader();
  reader.onload = async function (e) {
    const base64 = e.target.result;
    
    const payload = {
      photo: base64,
      msgType: 'photo',
      senderID: myID,
      receiverID: otherID,
      status: 'sent',
      timestamp: Date.now()
    };
    
    if (replyTo) {
      payload.replyTo = replyTo;
      cancelReply();
    }
    
    try {
      const newRef = await push(ref(db, 'messages/' + chatKey), payload);
      const msg = { 
        ...payload, 
        id: newRef.key, 
        type: 'sent' 
      };
      
      // Add to renderedIDs immediately to block onChildAdded duplicate
      renderedIDs.add(msg.id);
      saveMessageToLocal(msg);
      removeSendingPlaceholder(tempID);
      renderMessage(msg);
      scrollToBottom();
    } catch (err) { 
      removeSendingPlaceholder(tempID); 
      console.error('Photo send error:', err);
      alert('Failed to send photo.'); 
    }
  };
  
  reader.readAsDataURL(file);
  event.target.value = '';
}

// ─── VOICE RECORDING ───────────────────────────────────────

window.startRecording = async function (e) {
  e.preventDefault();
  
  if (isRecording) return;
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 64;
    source.connect(analyserNode);

    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    waveformData = [];
    isRecording = true;

    const btn = document.getElementById('voiceBtn');
    btn.classList.add('recording');
    btn.innerHTML = '<i class="fa-solid fa-stop"></i>';

    const recWave = document.getElementById('recordingWaveform');
    recWave.classList.add('active');
    recWave.innerHTML = '';
    waveformBars = [];
    
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement('div');
      bar.className = 'recording-bar';
      recWave.appendChild(bar);
      waveformBars.push(bar);
    }
    
    document.getElementById('messageInput').style.display = 'none';

    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    
    function animateBars() {
      if (!isRecording) return;
      
      analyserNode.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const normalized = avg / 255;
      waveformData.push(normalized);
      
      waveformBars.forEach((bar, i) => {
        const offset = waveformData.length - waveformBars.length + i;
        const val = offset >= 0 && waveformData[offset] ? waveformData[offset] : 0.05;
        const h = Math.max(4, Math.round(val * 28));
        bar.style.height = h + 'px';
      });
      
      animationFrameID = requestAnimationFrame(animateBars);
    }
    
    animateBars();

    mediaRecorder.ondataavailable = (e) => { 
      if (e.data.size > 0) audioChunks.push(e.data); 
    };
    
    mediaRecorder.start();
  } catch (err) { 
    console.error('Recording error:', err);
    alert('Microphone access denied.'); 
  }
}

window.stopRecording = async function (e) {
  e.preventDefault();
  
  if (!isRecording || !mediaRecorder) return;
  
  isRecording = false;
  cancelAnimationFrame(animationFrameID);

  const btn = document.getElementById('voiceBtn');
  btn.classList.remove('recording');
  btn.innerHTML = '<i class="fa-solid fa-microphone"></i>';

  document.getElementById('recordingWaveform').classList.remove('active');
  document.getElementById('messageInput').style.display = '';

  const capturedWaveform = [...waveformData];
  const tempID = 'temp_' + Date.now();
  renderSendingPlaceholder('audio', tempID);

  mediaRecorder.stop();
  
  mediaRecorder.onstop = async () => {
    if (audioChunks.length === 0) { 
      removeSendingPlaceholder(tempID); 
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      return; 
    }
    
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    
    if (audioBlob.size < 1000) {
      removeSendingPlaceholder(tempID);
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      return;
    }
    
    const reader = new FileReader();
    reader.onload = async function (e) {
      const base64 = e.target.result;
      const sampled = sampleWaveform(capturedWaveform, 40);
      
      const payload = {
        audio: base64,
        msgType: 'audio',
        senderID: myID,
        receiverID: otherID,
        status: 'sent',
        waveform: sampled,
        timestamp: Date.now()
      };
      
      if (replyTo) {
        payload.replyTo = replyTo;
        cancelReply();
      }
      
      try {
        const newRef = await push(ref(db, 'messages/' + chatKey), payload);
        const msg = { 
          ...payload, 
          id: newRef.key, 
          type: 'sent' 
        };
        
        // Add to renderedIDs immediately to block onChildAdded duplicate
        renderedIDs.add(msg.id);
        saveMessageToLocal(msg);
        removeSendingPlaceholder(tempID);
        renderMessage(msg);
        scrollToBottom();
      } catch (err) { 
        removeSendingPlaceholder(tempID); 
        console.error('Voice send error:', err);
        alert('Failed to send voice message.'); 
      }
    };
    
    reader.readAsDataURL(audioBlob);
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  };
}

window.cancelRecording = function () {
  if (!isRecording || !mediaRecorder) return;
  
  isRecording = false;
  cancelAnimationFrame(animationFrameID);
  audioChunks = [];
  
  const btn = document.getElementById('voiceBtn');
  btn.classList.remove('recording');
  btn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
  
  document.getElementById('recordingWaveform').classList.remove('active');
  document.getElementById('messageInput').style.display = '';
  
  mediaRecorder.stop();
  mediaRecorder.onstop = () => { 
    mediaRecorder.stream.getTracks().forEach(t => t.stop()); 
  };
}

// ─── SAVE TO LOCAL ─────────────────────────────────────────

async function saveMessageToLocal(msg) {
  // Save binary media to IndexedDB, text metadata to localStorage
  if (msg.msgType === 'photo' && msg.photo) {
    await saveMedia(msg.id, msg.photo, 'photo');
  }
  if (msg.msgType === 'audio' && msg.audio) {
    await saveMedia(msg.id, msg.audio, 'audio');
  }
  saveTextMessage(chatKey, msg);
}

// ─── RENDER MESSAGE ────────────────────────────────────────

function renderMessage(msg) {
  const container = document.getElementById('messagesContainer');
  if (!container) return;
  
  messageDataStore[msg.id] = msg;
  renderDateSeparatorIfNeeded(msg.timestamp, container);

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${msg.type === 'sent' ? 'sent' : 'received'}`;
  wrapper.setAttribute('data-id', msg.id);

  const isSent = msg.type === 'sent';
  const ticksHTML = isSent ? getTicks(msg.status || 'sent') : '';
  const reactionsHTML = buildReactionsHTML(msg.reactions || {});
  const replyHTML = msg.replyTo ? buildReplyHTML(msg.replyTo) : '';
  
  const forwardedHTML = msg.forwarded
    ? `<div style="font-size:11px;color:#888;margin-bottom:3px;">
        <i class="fa-solid fa-share" style="font-size:10px;"></i> Forwarded
       </div>`
    : '';

  let msgContent = '';
  
  if (msg.msgType === 'photo' && msg.photo) {
    msgContent = `<img src="${msg.photo}" class="msg-photo" onclick="openPhoto(this.src)" />`;
  } else if (msg.msgType === 'audio' && msg.audio) {
    msgContent = renderVoiceCard(msg);
  } else if (msg.msgType === 'call') {
    const isMissed = msg.callStatus === 'missed';
    const isDeclined = msg.callStatus === 'declined';
    const iconClass = msg.callType === 'video' ? 'fa-video' : 'fa-phone';
    const color = (isMissed || isDeclined) ? '#e53935' : '#128C7E';
    
    msgContent = `
      <div class="call-msg-bubble ${isMissed ? 'missed' : ''}">
        <i class="fa-solid ${iconClass}" style="color:${color};"></i>
        <span>${msg.text}</span>
      </div>`;
  } else {
    msgContent = `<div>${msg.text}</div>`;
  }

  const bubble = document.createElement('div');
  bubble.className = `message ${isSent ? 'sent' : 'received'}`;
  bubble.innerHTML = `
    ${forwardedHTML}
    ${replyHTML}
    ${msgContent}
    <div class="msg-meta">
      <span class="msg-time">${formatTime(msg.timestamp)}</span>
      ${ticksHTML}
    </div>
    <div class="msg-reactions">${reactionsHTML}</div>
  `;

  const actionBtn = document.createElement('button');
  actionBtn.className = 'msg-action-btn';
  actionBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
  actionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openBottomSheet(msg.id);
  });

  wrapper.appendChild(bubble);
  wrapper.appendChild(actionBtn);
  container.appendChild(wrapper);
}

// ─── PHOTO VIEWER ──────────────────────────────────────────

window.openPhoto = function (src) {
  const modal = document.getElementById('photoModal');
  const img = document.getElementById('photoModalImg');
  
  if (modal && img) {
    img.src = src;
    modal.style.display = 'flex';
  }
}

window.closePhoto = function () {
  const modal = document.getElementById('photoModal');
  const img = document.getElementById('photoModalImg');
  
  if (modal && img) {
    modal.style.display = 'none';
    img.src = '';
  }
}

// ─── TYPING INDICATOR ──────────────────────────────────────────────────

let typingTimeout = null;
let isTypingEmitted = false;

// ─── OFFLINE / ONLINE DETECTION ─────────────────────────────────────────────

function initOfflineDetection() {
  updateOfflineBar();

  window.addEventListener('online', () => {
    isOnline = true;
    updateOfflineBar();
    flushMessageQueue();
    // Re-sync missed messages
    syncFromFirebase();
  });

  window.addEventListener('offline', () => {
    isOnline = false;
    updateOfflineBar();
  });
}

function updateOfflineBar() {
  let bar = document.getElementById('offlineBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'offlineBar';
    bar.className = 'offline-bar';
    // Insert after header
    const header = document.getElementById('chatHeader');
    if (header && header.nextSibling) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
      document.body.prepend(bar);
    }
  }

  if (isOnline) {
    bar.classList.remove('visible');
  } else {
    bar.innerHTML = '<i class="fa-solid fa-wifi-slash"></i> You are offline — showing cached messages';
    bar.classList.add('visible');
  }
}

async function flushMessageQueue() {
  const queue = getQueue();
  if (!queue.length) return;

  for (const item of queue) {
    try {
      const newRef = await push(ref(db, 'messages/' + item.chatKey), item.payload);
      removeFromQueue(item.queuedAt);

      // If this is the current chat, replace the pending bubble
      if (item.chatKey === chatKey) {
        const msg = { ...item.payload, id: newRef.key, type: 'sent' };
        // Find and remove any pending_ bubble with matching text + timestamp
        const pendingEls = document.querySelectorAll('[data-id^="pending_"]');
        for (const el of pendingEls) {
          const elMsg = messageDataStore[el.dataset.id];
          if (elMsg && elMsg.text === item.payload.text && Math.abs(elMsg.timestamp - item.payload.timestamp) < 5000) {
            renderedIDs.delete(el.dataset.id);
            el.remove();
            break;
          }
        }
        renderedIDs.add(msg.id);
        renderMessage(msg);
        saveMessageToLocal(msg);
        scrollToBottom();
      }
    } catch (err) {
      console.error('Queue flush error:', err);
    }
  }
}

function setupTypingEmitter() {
  const input = document.getElementById('messageInput');
  if (!input) return;

  // Clear typing status when user leaves the page
  window.addEventListener('beforeunload', () => {
    update(ref(db, 'typing/' + chatKey + '/' + myID), { typing: false }).catch(() => {});
  });

  input.addEventListener('input', () => {
    if (!isTypingEmitted) {
      isTypingEmitted = true;
      update(ref(db, 'typing/' + chatKey + '/' + myID), { typing: true }).catch(() => {});
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTypingEmitted = false;
      update(ref(db, 'typing/' + chatKey + '/' + myID), { typing: false }).catch(() => {});
    }, 2000);
  });
}

function listenToTyping() {
  const typingRef = ref(db, 'typing/' + chatKey + '/' + otherID);
  onValue(typingRef, (snapshot) => {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    let indicator = document.getElementById('typingIndicator');

    if (snapshot.exists() && snapshot.val().typing === true) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'typingIndicator';
        indicator.className = 'typing-indicator';
        indicator.innerHTML = `
          <div class="typing-bubble">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>`;
        container.appendChild(indicator);
        scrollToBottom();
      }
    } else {
      if (indicator) indicator.remove();
    }
  });
}

// ─── DATE SEPARATOR ──────────────────────────────────────────────────

let lastRenderedDate = null;

function getDateLabel(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderDateSeparatorIfNeeded(timestamp, container) {
  const label = getDateLabel(timestamp);
  if (label !== lastRenderedDate) {
    lastRenderedDate = label;
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.innerHTML = `<span>${label}</span>`;
    container.appendChild(sep);
  }
}
