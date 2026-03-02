import { notifyIncomingCall, notifyMissedCall, dismissCallNotification } from './notifications.js';
import { db, auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
  ref, get, onValue, update, remove
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

let myID = null;
let activeCallData = null;
let ringtone = null;
let missedTimer = null;

// ─── INIT ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  myID = localStorage.getItem('aschat_userID');
  if (!myID || myID === 'null') {
    const snap = await get(ref(db, 'userMap/' + user.uid));
    if (snap.exists()) {
      myID = snap.val();
      localStorage.setItem('aschat_userID', myID);
    }
  }

  if (!myID) return;

  listenForIncomingCall();
});

// ─── LISTEN ────────────────────────────────────────────────────────────────────
function listenForIncomingCall() {
  onValue(ref(db, 'calls/' + myID), (snap) => {
    // Call ended / cancelled while popup is open
    if (!snap.exists()) {
      if (activeCallData) {
        hidePopup();
      }
      return;
    }

    const data = snap.val();

    // Caller gave up or call already handled
    if (data.status === 'missed' || data.status === 'ended' || data.status === 'declined') {
      if (activeCallData) hidePopup();
      return;
    }

    // New incoming ringing call
    if ((data.status === 'ringing' || !data.status) && !activeCallData) {
      activeCallData = data;
      showPopup(data);
    }
  });
}

// ─── SHOW POPUP ────────────────────────────────────────────────────────────────
function showPopup(data) {
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[data.callerID];
  const callerName = contact ? contact.name : (data.callerName || 'Unknown');
  const callerPhoto = contact ? contact.photo : null;
  const isVideo = data.callType === 'video' || data.type === 'video';

  // Avatar HTML
  const avatarHTML = callerPhoto
    ? `<img src="${callerPhoto}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : `<span style="font-size:26px;font-weight:700;color:#fff;">${callerName.charAt(0).toUpperCase()}</span>`;

  const popup = document.createElement('div');
  popup.id = 'globalCallPopup';
  popup.innerHTML = `
    <div class="gc-popup-inner">
      <div class="gc-left">
        <div class="gc-avatar">${avatarHTML}</div>
        <div class="gc-info">
          <div class="gc-label">${isVideo ? '📹 Incoming Video Call' : '📞 Incoming Voice Call'}</div>
          <div class="gc-name">${callerName}</div>
        </div>
      </div>
      <div class="gc-actions">
        <button class="gc-btn gc-decline" id="gcDeclineBtn" onclick="window._gcDecline()">
          <i class="fa-solid fa-phone-slash"></i>
        </button>
        <button class="gc-btn gc-accept" id="gcAcceptBtn" onclick="window._gcAccept()">
          <i class="fa-solid fa-phone"></i>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  // Animate in
  requestAnimationFrame(() => {
    popup.classList.add('gc-visible');
  });

  playRingtone();

  // 🔔 Fire OS notification for the incoming call (works when app is in background)
  notifyIncomingCall(callerName, data.callerID, data.callType, callerPhoto);

  // Auto-dismiss after 30s (missed)
  missedTimer = setTimeout(() => {
    hidePopup();
    // 🔔 Fire missed call OS notification
    notifyMissedCall(callerName, data.callerID, data.callType, callerPhoto);
  }, 30000);

  // Global handlers
  window._gcAccept = acceptCall;
  window._gcDecline = declineCall;
}

// ─── HIDE POPUP ────────────────────────────────────────────────────────────────
function hidePopup() {
  clearTimeout(missedTimer);
  stopRingtone();

  // 🔔 Dismiss the OS call notification if it's still showing
  if (activeCallData) {
    dismissCallNotification(activeCallData.callerID);
  }

  activeCallData = null;

  const popup = document.getElementById('globalCallPopup');
  if (!popup) return;

  popup.classList.remove('gc-visible');
  popup.classList.add('gc-hiding');
  setTimeout(() => popup.remove(), 400);
}

// ─── ACCEPT ────────────────────────────────────────────────────────────────────
async function acceptCall() {
  if (!activeCallData) return;

  const callerID = activeCallData.callerID;
  const callType = activeCallData.callType || activeCallData.type || 'voice';

  // Get caller name for URL
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[callerID];
  const callerName = contact ? contact.name : (activeCallData.callerName || 'User');

  hidePopup();

  // Navigate to the chat page — chat.js + call.js will handle the rest
  // Pass a flag so chat.js knows to auto-accept on load
  const encodedName = encodeURIComponent(callerName);
  window.location.href = `chat.html?id=${callerID}&name=${encodedName}&autocall=accept&calltype=${callType}`;
}

// ─── DECLINE ───────────────────────────────────────────────────────────────────
async function declineCall() {
  if (!activeCallData) return;

  const data = activeCallData;
  hidePopup();

  try {
    await update(ref(db, 'calls/' + myID), { status: 'declined' });

    // Save "Call declined" message so the caller sees it in chat
    const chatKey = [myID, data.callerID].sort().join('_');
    const icon = data.callType === 'video' ? '📹' : '📞';
    const { push: pushRef } = await import("https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js");
    await pushRef(ref(db, 'messages/' + chatKey), {
      text: `${icon} Call declined`,
      msgType: 'call',
      callType: data.callType,
      callStatus: 'declined',
      senderID: myID,
      receiverID: data.callerID,
      status: 'sent',
      timestamp: Date.now()
    }).catch(() => {});

    setTimeout(async () => {
      await remove(ref(db, 'calls/' + myID)).catch(() => {});
      if (data.callID) await remove(ref(db, 'calls/' + data.callID)).catch(() => {});
    }, 1500);
  } catch (e) {
    console.error('Decline error:', e);
  }
}

// ─── RINGTONE ──────────────────────────────────────────────────────────────────
let _audioCtx = null;
let _ringNodes = [];

function playRingtone() {
  stopRingtone();
  // Try external URL first; fall back to synthesized tone if it fails
  ringtone = new Audio('https://www.soundjay.com/phone/sounds/phone-calling-1.mp3');
  ringtone.loop = true;
  ringtone.play().catch(() => {
    // External URL failed — generate a simple phone ring using Web Audio API
    ringtone = null;
    _playTone();
  });
}

function _playTone() {
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const playBeep = () => {
      if (!_audioCtx) return;
      const osc  = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.connect(gain);
      gain.connect(_audioCtx.destination);
      osc.frequency.value = 480;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.4, _audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.8);
      osc.start(_audioCtx.currentTime);
      osc.stop(_audioCtx.currentTime + 0.8);
      _ringNodes.push(osc);
    };
    playBeep();
    // Repeat every 3 seconds
    const id = setInterval(() => {
      if (!_audioCtx) { clearInterval(id); return; }
      playBeep();
    }, 3000);
    _ringNodes.push({ stop: () => clearInterval(id) }); // store interval handle
  } catch (e) {}
}

function stopRingtone() {
  if (ringtone) {
    ringtone.pause();
    ringtone.currentTime = 0;
    ringtone = null;
  }
  // Stop synthesized tone
  _ringNodes.forEach(n => { try { n.stop(); } catch (e) {} });
  _ringNodes = [];
  if (_audioCtx) {
    _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }
}

// ─── HANDLE SW NOTIFICATION ACTIONS ──────────────────────────────────────────
// When user taps "Decline" on an OS call notification while app is open,
// the SW posts this message back to the page.
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'DECLINE_CALL_FROM_NOTIFICATION') {
    if (activeCallData && activeCallData.callerID === event.data.callerID) {
      declineCall();
    }
  }
});
