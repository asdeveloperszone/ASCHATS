import { db } from './firebase-config.js';
import {
  ref, set, get, onValue, remove, push, update, off
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

// ─── ICE SERVER CONFIG ─────────────────────────────────────────────────────
// Fallback STUN-only config used if TURN fetch fails
const STUN_ONLY = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// Cached ICE config (populated by fetchIceServers before each call)
let ICE_SERVERS = STUN_ONLY;

// Fetches free TURN credentials from Metered Open Relay at runtime.
// Credentials are short-lived so we re-fetch each call session.
async function fetchIceServers() {
  try {
    const res = await fetch(
      'https://aschat.metered.live/api/v1/turn/credentials?apiKey=1fb7aac41a133ef1f772a26ea231b12b0825'
    );
    if (!res.ok) throw new Error('Metered fetch failed: ' + res.status);
    const servers = await res.json();
    if (!Array.isArray(servers) || servers.length === 0) throw new Error('Empty server list');

    // Always include Google STUN alongside TURN for fastest path selection
    ICE_SERVERS = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        ...servers
      ]
    };
    console.log('[Call] ICE servers ready:', ICE_SERVERS.iceServers.length, 'servers (incl. TURN)');
  } catch (err) {
    console.warn('[Call] TURN fetch failed, falling back to STUN only:', err.message);
    ICE_SERVERS = STUN_ONLY;
  }
}

// ─── STATE ─────────────────────────────────────────────────────────────────
let peerConnection = null;
let localStream = null;
let callType = null;      // 'voice' | 'video'
let callRole = null;      // 'caller' | 'receiver'
let myID = null;
let otherID = null;
let otherName = null;
let callTimerInterval = null;
let callSeconds = 0;
let onCallEndedCallback = null;
let isMuted = false;
let isCamOff = false;
let isSpeakerOn = false;
let activeListeners = [];
let incomingCallData = null;  // stored so acceptCall / declineCall can use it

// ─── INIT ──────────────────────────────────────────────────────────────────
export function initCall(uid, oid, name, onEnd) {
  myID = uid;
  otherID = oid;
  otherName = name;
  onCallEndedCallback = onEnd;
  // Pre-fetch TURN credentials in background so they are ready when call starts
  fetchIceServers();
  listenForIncomingCall();
}

// ─── SET ONLINE PRESENCE ──────────────────────────────────────────────────
export function setOnline(uid) {
  // Write online presence; remove on disconnect
  import("https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js")
    .then(({ onDisconnect }) => {
      const presenceRef = ref(db, 'presence/' + uid);
      set(presenceRef, 'online').catch(() => {});
      onDisconnect(presenceRef).set('offline').catch(() => {});
    }).catch(() => {});
}

// ─── LISTEN FOR INCOMING CALLS (on this chat page) ────────────────────────
function listenForIncomingCall() {
  const callRef = ref(db, 'calls/' + myID);
  const sub = onValue(callRef, async (snap) => {
    if (!snap.exists()) {
      // Call was cancelled / cleaned up
      if (incomingCallData) {
        hideAllCallScreens();
        incomingCallData = null;
      }
      return;
    }

    const data = snap.val();

    // Ignore answers / ICE sub-nodes only (no callerID means it's a sub-node update)
    if (!data.callerID) return;

    // Ignore if it's our own outgoing call data
    if (data.callerID === myID) return;

    // Already handling a call
    if (incomingCallData) return;

    // Declined / ended / missed status — remote party hung up or missed
    if (data.status === 'declined' || data.status === 'ended' || data.status === 'missed') {
      // If we're in an active call and the other side ended it, clean up fully
      if (peerConnection || localStream) {
        saveCallMessage(callSeconds > 0 ? 'ended' : 'missed');
        cleanupCallState();
        if (onCallEndedCallback) onCallEndedCallback();
      } else {
        hideAllCallScreens();
      }
      incomingCallData = null;
      return;
    }

    // New incoming call (status: 'ringing' or any pending)
    incomingCallData = data;
    showIncomingCallScreen(data);
  });
  activeListeners.push({ ref: callRef, cb: sub });
}

// ─── START OUTGOING CALL ──────────────────────────────────────────────────
export async function startCall(type) {
  callType = type;
  callRole = 'caller';

  try {
    // Fetch fresh TURN credentials and acquire media in parallel for speed
    const [, stream] = await Promise.all([
      fetchIceServers(),
      navigator.mediaDevices.getUserMedia({ video: type === 'video', audio: true })
    ]);
    localStream = stream;

    showOutgoingCallScreen(type);

    // Show local video preview in outgoing screen for video calls
    const localVideoOut = document.getElementById('localVideoOut');
    if (localVideoOut && type === 'video') {
      localVideoOut.srcObject = localStream;
      localVideoOut.style.display = 'block'; // FIX: was missing — preview was always hidden
    }

    createPeerConnection();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // FIX: Use 'callType' field consistently (global-call.js reads callType)
    // FIX: Set status to 'ringing' so global-call.js popup triggers
    await set(ref(db, `calls/${otherID}`), {
      callerID: myID,
      callerName: localStorage.getItem('aschat_name') || 'User',
      callType: type,    // FIX: was only 'type', global-call reads 'callType'
      type: type,        // keep both for compatibility
      status: 'ringing', // FIX: global-call.js checks for 'ringing' status
      offer: { type: offer.type, sdp: offer.sdp },
      timestamp: Date.now()
    });

    // Listen for answer
    const answerRef = ref(db, `calls/${otherID}/answer`);
    const answerSub = onValue(answerRef, async (snap) => {
      if (snap.exists() && peerConnection && !peerConnection.currentRemoteDescription) {
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(snap.val()));
          showActiveCallScreen();
          startCallTimer();
        } catch (e) {
          console.error('Set remote description error:', e);
        }
      }
    });
    activeListeners.push({ ref: answerRef, cb: answerSub });

    // FIX: Caller listens for receiver's ICE candidates at calls/${otherID}/iceCandidates/${otherID}
    listenForIceCandidates(otherID, otherID);
    playRingtone();
    saveCallMessage('started');
  } catch (err) {
    console.error('Call Start Error:', err);
    handleCallError(err);
  }
}

// ─── ACCEPT INCOMING CALL ─────────────────────────────────────────────────
export async function acceptCall() {
  let callData = incomingCallData;

  if (!callData) {
    // Called from autocall=accept URL param — fetch call data from Firebase
    try {
      const snap = await get(ref(db, `calls/${myID}`));
      if (!snap.exists()) { console.warn('No incoming call data'); return; }
      callData = snap.val();
      incomingCallData = callData;
    } catch (e) {
      console.error('acceptCall fetch error:', e);
      return;
    }
  }

  callType = callData.callType || callData.type || 'voice';
  callRole = 'receiver';

  stopRingtone();

  try {
    // Fetch fresh TURN credentials and acquire media in parallel
    const [, stream] = await Promise.all([
      fetchIceServers(),
      navigator.mediaDevices.getUserMedia({ video: callType === 'video', audio: true })
    ]);
    localStream = stream;

    createPeerConnection();

    await peerConnection.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // Write answer under our path (myID) so caller can read it from calls/${myID}/answer
    await update(ref(db, `calls/${myID}`), {
      answer: { type: answer.type, sdp: answer.sdp },
      status: 'accepted'
    });

    // FIX: Receiver listens for caller's ICE candidates at calls/${myID}/iceCandidates/${callData.callerID}
    listenForIceCandidates(myID, callData.callerID);

    showActiveCallScreen();
    startCallTimer();
    incomingCallData = null;
  } catch (err) {
    console.error('Call Accept Error:', err);
    handleCallError(err);
  }
}

// ─── DECLINE CALL ─────────────────────────────────────────────────────────
export async function declineCall() {
  stopRingtone();
  hideAllCallScreens();

  try {
    await update(ref(db, `calls/${myID}`), { status: 'declined' });
    const callData = incomingCallData || {};
    const chatKey = [myID, otherID].sort().join('_');
    const icon = (callData.callType || callData.type) === 'video' ? '📹' : '📞';
    await push(ref(db, 'messages/' + chatKey), {
      text: `${icon} Call declined`,
      msgType: 'call',
      callType: callData.callType || callData.type || 'voice',
      callStatus: 'declined',
      senderID: myID,
      receiverID: otherID,
      status: 'sent',
      timestamp: Date.now()
    }).catch(() => {});
    setTimeout(() => remove(ref(db, `calls/${myID}`)).catch(() => {}), 1500);
  } catch (e) {
    console.error('Decline error:', e);
  }

  incomingCallData = null;
}

// ─── END ACTIVE CALL ──────────────────────────────────────────────────────
export function endCall() {
  saveCallMessage(callSeconds > 0 ? 'ended' : 'declined', formatDuration(callSeconds));
  stopRingtone();

  // Signal the other side that the call has ended so their screen dismisses
  // Caller writes to calls/${otherID}, receiver writes to calls/${myID}
  // We need to notify the node the OTHER person is watching:
  //   - Caller watches calls/${otherID} for answer → receiver should update calls/${otherID}
  //   - Receiver watches calls/${myID} for status  → caller should update calls/${myID}
  // Both sides watch their own node (calls/${myID}) for incoming status,
  // so the ending party must write 'ended' to the OTHER's node.
  if (otherID) {
    update(ref(db, `calls/${otherID}`), { status: 'ended' }).catch(() => {});
  }

  cleanupCallState();
  if (onCallEndedCallback) onCallEndedCallback();
}

// ─── ICE CANDIDATE HANDLING ───────────────────────────────────────────────
// FIX: Unified ICE path — each side writes their candidates under:
//   calls/${targetPath}/iceCandidates/${myID}
// Caller  writes: calls/${otherID}/iceCandidates/${myID}   ← receiver reads this
// Receiver writes: calls/${myID}/iceCandidates/${myID}     ← but caller listens at calls/${otherID}
// Wait — caller's path IS calls/${otherID}, so receiver's data is at
//   calls/${otherID}/iceCandidates/${otherID} — which is what caller listens to!
// This is consistent because both use myID as the sub-key.
function listenForIceCandidates(callPath, fromID) {
  const iceRef = ref(db, `calls/${callPath}/iceCandidates/${fromID}`);
  const iceSub = onValue(iceRef, (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach((child) => {
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(() => {});
    });
  });
  activeListeners.push({ ref: iceRef, cb: iceSub });
}

// ─── PEER CONNECTION ──────────────────────────────────────────────────────
function createPeerConnection() {
  if (peerConnection) peerConnection.close();
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    if (!event.streams[0]) return;
    if (callType === 'video') {
      // Video call — route stream to video element (carries both audio + video)
      const remoteVideo = document.getElementById('remoteVideo');
      if (remoteVideo) remoteVideo.srcObject = event.streams[0];
    } else {
      // Voice call — route stream to dedicated audio element
      // (hidden video elements are muted on iOS/Safari — this is the fix)
      const remoteAudio = document.getElementById('remoteAudio');
      if (remoteAudio) {
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play().catch(() => {});
      }
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      // Each side writes their ICE candidate under calls/${targetPath}/iceCandidates/${myID}
      // Caller:   writes to calls/${otherID}/iceCandidates/${myID}
      // Receiver: writes to calls/${myID}/iceCandidates/${myID}
      const targetPath = callRole === 'caller' ? otherID : myID;
      push(ref(db, `calls/${targetPath}/iceCandidates/${myID}`), event.candidate.toJSON()).catch(() => {});
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE state:', peerConnection.iceConnectionState);
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('Connection state:', state);
    if (['disconnected', 'failed', 'closed'].includes(state)) {
      endCall();
    }
  };
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────
function cleanupCallState() {
  activeListeners.forEach(l => off(l.ref, 'value', l.cb));
  activeListeners = [];

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callSeconds = 0;
  isMuted = false;
  isCamOff = false;
  isSpeakerOn = false;
  _currentFacingMode = 'user';

  // Tear down Web Audio speaker routing if active
  if (_speakerSource) { try { _speakerSource.disconnect(); } catch(e){} _speakerSource = null; }
  if (_speakerAudioCtx) { _speakerAudioCtx.close().catch(()=>{}); _speakerAudioCtx = null; }

  // Remove our node immediately; remove other's node after a short delay
  // so they have time to read the 'ended' status before it disappears.
  if (myID) remove(ref(db, `calls/${myID}`)).catch(() => {});
  if (otherID) setTimeout(() => remove(ref(db, `calls/${otherID}`)).catch(() => {}), 2000);

  hideAllCallScreens();

  const rv = document.getElementById('remoteVideo');
  const lv = document.getElementById('localVideo');
  const lvOut = document.getElementById('localVideoOut');
  const ra = document.getElementById('remoteAudio');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  if (lvOut) { lvOut.srcObject = null; lvOut.style.display = 'none'; }
  if (ra) { ra.srcObject = null; ra.pause(); }
}

// ─── CALL TIMER ───────────────────────────────────────────────────────────
function startCallTimer() {
  if (callTimerInterval) return;
  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    // FIX: HTML uses id="callTimer", not "callDuration"
    const display = document.getElementById('callTimer');
    if (display) display.textContent = formatDuration(callSeconds);
  }, 1000);
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── UI: SHOW / HIDE CALL SCREENS ─────────────────────────────────────────
function hideAllCallScreens() {
  ['outgoingCallScreen', 'incomingCallScreen', 'activeCallScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  stopRingtone();
}

function showOutgoingCallScreen(type) {
  hideAllCallScreens();

  const screen = document.getElementById('outgoingCallScreen');
  if (!screen) return;

  const nameEl = document.getElementById('outCallName');
  if (nameEl) nameEl.textContent = otherName || 'Unknown';

  const avatarEl = document.getElementById('outCallAvatar');
  if (avatarEl) {
    const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
    const contact = contacts[otherID];
    if (contact && contact.photo) {
      avatarEl.innerHTML = `<img src="${contact.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      avatarEl.textContent = (otherName || 'U').charAt(0).toUpperCase();
    }
  }

  const statusEl = document.getElementById('outCallStatus');
  if (statusEl) statusEl.textContent = type === 'video' ? '📹 Video Calling...' : '📞 Voice Calling...';

  screen.style.display = 'flex';
}

function showIncomingCallScreen(data) {
  hideAllCallScreens();

  const screen = document.getElementById('incomingCallScreen');
  if (!screen) return;

  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[data.callerID];
  const callerName = contact ? contact.name : (data.callerName || 'Unknown');
  const isVideo = (data.callType || data.type) === 'video';

  const nameEl = document.getElementById('inCallName');
  if (nameEl) nameEl.textContent = callerName;

  const typeLabel = document.getElementById('inCallTypeLabel');
  if (typeLabel) typeLabel.textContent = isVideo ? '📹 Incoming Video Call' : '📞 Incoming Voice Call';

  const avatarEl = document.getElementById('inCallAvatar');
  if (avatarEl) {
    if (contact && contact.photo) {
      avatarEl.innerHTML = `<img src="${contact.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      avatarEl.textContent = callerName.charAt(0).toUpperCase();
    }
  }

  screen.style.display = 'flex';
  playRingtone();
}

function showActiveCallScreen() {
  hideAllCallScreens();

  const screen = document.getElementById('activeCallScreen');
  if (!screen) return;

  const nameEl = document.getElementById('activeCallName');
  if (nameEl) nameEl.textContent = otherName || 'Unknown';

  const avatarEl = document.getElementById('activeCallAvatar');
  if (avatarEl) {
    const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
    const contact = contacts[otherID];
    if (contact && contact.photo) {
      avatarEl.innerHTML = `<img src="${contact.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      avatarEl.textContent = (otherName || 'U').charAt(0).toUpperCase();
    }
  }

  // Show/hide camera button and videos based on call type
  const camBtn = document.getElementById('camBtn');
  if (camBtn) camBtn.style.display = callType === 'video' ? 'flex' : 'none';

  const flipBtn = document.getElementById('flipBtn');
  if (flipBtn) flipBtn.style.display = callType === 'video' ? 'flex' : 'none';

  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo) remoteVideo.style.display = callType === 'video' ? 'block' : 'none';

  // Attach local video stream
  const localVideo = document.getElementById('localVideo');
  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.style.display = callType === 'video' ? 'block' : 'none';
  }

  screen.style.display = 'flex';
}

// ─── TOGGLE MUTE ──────────────────────────────────────────────────────────
export function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  if (btn) {
    btn.innerHTML = isMuted
      ? '<i class="fa-solid fa-microphone-slash"></i><span>Unmute</span>'
      : '<i class="fa-solid fa-microphone"></i><span>Mute</span>';
  }
}

// ─── TOGGLE SPEAKER ───────────────────────────────────────────────────────
// FIX: setSinkId only works on desktop Chrome. On mobile (iOS Safari, Android Chrome)
// we use Web Audio API to route audio to the speakers via an AudioContext node.
let _speakerAudioCtx = null;
let _speakerSource = null;

export function toggleSpeaker() {
  isSpeakerOn = !isSpeakerOn;
  const btn = document.getElementById('speakerBtn');
  if (btn) {
    btn.innerHTML = isSpeakerOn
      ? '<i class="fa-solid fa-volume-xmark"></i><span>Speaker</span>'
      : '<i class="fa-solid fa-volume-high"></i><span>Speaker</span>';
    btn.classList.toggle('active', isSpeakerOn);
  }

  const audioEl = callType === 'video'
    ? document.getElementById('remoteVideo')
    : document.getElementById('remoteAudio');

  if (!audioEl) return;

  // Try setSinkId first (desktop Chrome/Edge)
  if (audioEl.setSinkId) {
    audioEl.setSinkId(isSpeakerOn ? 'default' : '').catch(() => {});
    return;
  }

  // Fallback: Web Audio API — creates a gain node to force audio through speaker
  try {
    if (isSpeakerOn) {
      if (!_speakerAudioCtx) {
        _speakerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (_speakerAudioCtx.state === 'suspended') _speakerAudioCtx.resume();
      if (_speakerSource) _speakerSource.disconnect();
      _speakerSource = _speakerAudioCtx.createMediaElementSource(audioEl);
      _speakerSource.connect(_speakerAudioCtx.destination);
    } else {
      if (_speakerSource) {
        _speakerSource.disconnect();
        _speakerSource = null;
      }
      if (_speakerAudioCtx) {
        _speakerAudioCtx.close().catch(() => {});
        _speakerAudioCtx = null;
      }
      // Reconnect the element to default output
      audioEl.srcObject = audioEl.srcObject; // triggers re-bind to default sink
    }
  } catch (e) {
    console.warn('[Call] Speaker toggle fallback failed:', e.message);
  }
}

// ─── TOGGLE CAMERA ────────────────────────────────────────────────────────
export function toggleCamera() {
  if (!localStream || callType !== 'video') return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  if (btn) {
    btn.innerHTML = isCamOff
      ? '<i class="fa-solid fa-video-slash"></i><span>Camera</span>'
      : '<i class="fa-solid fa-video"></i><span>Camera</span>';
  }
}

// ─── FLIP CAMERA (front ↔ back) ───────────────────────────────────────────
let _currentFacingMode = 'user'; // 'user' = front, 'environment' = back

export async function flipCamera() {
  if (!localStream || callType !== 'video' || !peerConnection) return;

  _currentFacingMode = _currentFacingMode === 'user' ? 'environment' : 'user';

  try {
    // Stop current video track
    localStream.getVideoTracks().forEach(t => t.stop());

    // Get new stream with opposite camera
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _currentFacingMode },
      audio: false
    });

    const newVideoTrack = newStream.getVideoTracks()[0];

    // Replace track in peer connection (no renegotiation needed)
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newVideoTrack);

    // Replace track in localStream
    localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
    localStream.addTrack(newVideoTrack);

    // Update local video preview
    const localVideo = document.getElementById('localVideo');
    if (localVideo) localVideo.srcObject = localStream;

    // Update flip button icon
    const btn = document.getElementById('flipBtn');
    if (btn) btn.classList.toggle('active', _currentFacingMode === 'environment');

  } catch (err) {
    console.warn('[Call] Camera flip failed:', err.message);
    // Revert facing mode on failure
    _currentFacingMode = _currentFacingMode === 'user' ? 'environment' : 'user';
  }
}

// ─── RINGTONE ─────────────────────────────────────────────────────────────
function playRingtone() {
  const ringtone = document.getElementById('ringtone');
  if (ringtone) {
    ringtone.play().catch(() => {});
  }
}

function stopRingtone() {
  const ringtone = document.getElementById('ringtone');
  if (ringtone) {
    ringtone.pause();
    ringtone.currentTime = 0;
  }
}

// ─── ERROR HANDLER ────────────────────────────────────────────────────────
function handleCallError(err) {
  let msg = 'Call failed.';
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    msg = 'Camera/microphone permission denied. Please allow access and try again.';
  } else if (err.name === 'NotFoundError') {
    msg = 'No camera or microphone found.';
  } else if (err.name === 'NotReadableError') {
    msg = 'Camera or microphone is already in use by another app.';
  }
  alert(msg);
  cleanupCallState();
  if (onCallEndedCallback) onCallEndedCallback();
}

// ─── SAVE CALL MESSAGE ────────────────────────────────────────────────────
async function saveCallMessage(status, duration = null) {
  if (!myID || !otherID) return;
  const chatKey = [myID, otherID].sort().join('_');
  const icon = callType === 'video' ? '📹' : '📞';
  const text = `${icon} ${callType || 'voice'} call ${status}${duration ? ' (' + duration + ')' : ''}`;
  try {
    await push(ref(db, 'messages/' + chatKey), {
      text,
      msgType: 'call',
      callType: callType || 'voice',
      callStatus: status,
      senderID: myID,
      receiverID: otherID,
      timestamp: Date.now(),
      status: 'sent'
    });
  } catch (e) {}
}
