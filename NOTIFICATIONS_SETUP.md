# ASChat — Push Notification Setup Guide

This guide gets you from zero to **WhatsApp-style push notifications** that work
even when the app is fully closed or the phone screen is off.

---

## How It Works

```
User sends message / call
        │
        ▼
Firebase Realtime DB (new node written)
        │
        ▼
Cloud Function triggers (server-side, always running)
        │
        ▼
FCM (Firebase Cloud Messaging) push sent to device
        │
        ▼
firebase-messaging-sw.js wakes up on device
        │
        ▼
OS notification shown ← even if browser/app is fully closed
```

---

## Step 1 — Get Your VAPID Key

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select project **aschat-10454**
3. Click ⚙️ **Project Settings** → **Cloud Messaging** tab
4. Scroll to **"Web configuration"** → **"Web Push certificates"**
5. Click **"Generate key pair"** (or copy existing)
6. Copy the **Public Key** string

Open `js/notifications.js` and replace:
```js
const VAPID_KEY = 'YOUR_VAPID_KEY_HERE';
```
With:
```js
const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa40HI80NM9LdsDZ...'; // your key
```

---

## Step 2 — Deploy Cloud Functions

The Cloud Functions are in the `functions/` folder. They watch the database
and send FCM pushes when messages/calls arrive.

```bash
# Install Firebase CLI (once)
npm install -g firebase-tools

# Login to Firebase
firebase login

# Install function dependencies
cd functions
npm install
cd ..

# Deploy functions only
firebase deploy --only functions
```

You should see 4 functions deployed:
- `onNewMessage`  — triggers on every new chat message
- `onIncomingCall` — triggers when a call signal is written
- `onMissedCall`  — triggers when a call becomes 'missed'
- `onReaction`    — triggers when someone reacts to a message

> **Note:** Cloud Functions require the **Blaze (pay-as-you-go) plan**.
> The free Spark plan cannot make outbound network calls.
> For a small app, costs are typically under $1/month.

---

## Step 3 — Deploy Database Rules

```bash
firebase deploy --only database
```

This deploys `database.rules.json` which locks down who can read/write what.

---

## Step 4 — Deploy Hosting (optional but recommended)

If you use Firebase Hosting, the `firebase.json` is already configured
to set correct headers on `sw.js` and `firebase-messaging-sw.js`
(they need `Service-Worker-Allowed: /` to register at root scope).

```bash
firebase deploy --only hosting
```

---

## Step 5 — Test It

1. Open ASChat on two devices / browsers
2. On Device A: allow notifications when prompted after login
3. On Device B: send a message to Device A
4. **Minimize the browser** on Device A (or close it if PWA installed)
5. Device A should receive a push notification with the message preview

For calls: start a call from Device B → Device A receives a persistent
notification with **Accept** and **Decline** buttons.

---

## Notification Types

| Event | Notification | Actions |
|-------|-------------|---------|
| New text message | Sender name + message preview | Open, Dismiss |
| New photo | Sender name + "📷 Photo" | Open, Dismiss |
| New voice message | Sender name + "🎤 Voice message" | Open, Dismiss |
| Incoming call | Caller name + call type | ✅ Accept, ❌ Decline |
| Missed call | "Missed call from X" | Open Chat, Dismiss |
| Message reaction | "Reacted 👍 to your message" | Open, Dismiss |

---

## Troubleshooting

**"VAPID key not configured" warning in console**
→ Complete Step 1 above.

**Notifications work in browser but not when app is closed**
→ Complete Steps 2-3 (Cloud Functions not deployed yet).

**Cloud Function deploy fails with "billing" error**
→ Upgrade to Blaze plan at console.firebase.google.com → project → Spark → Upgrade.

**Notifications work on desktop but not mobile (PWA installed)**
→ On Android: long-press the PWA → App info → Notifications → Enable
→ On iOS 16.4+: PWA notifications require the app to be added to Home Screen first

**FCM token not being saved to database**
→ Check browser console for errors. Common causes:
  - VAPID key wrong or not set
  - `firebase-messaging-sw.js` not accessible at root URL
  - Browser blocks service workers (private/incognito mode)

---

## File Reference

| File | Purpose |
|------|---------|
| `firebase-messaging-sw.js` | FCM background SW — MUST be at domain root |
| `sw.js` | Caching SW + foreground/tab-backgrounded notifications |
| `js/notifications.js` | Client notification module + FCM token registration |
| `functions/index.js` | Cloud Functions that send FCM pushes server-side |
| `database.rules.json` | Firebase security rules (deploy with `firebase deploy --only database`) |
| `firebase.json` | Firebase project config |
| `.firebaserc` | Links to Firebase project aschat-10454 |
