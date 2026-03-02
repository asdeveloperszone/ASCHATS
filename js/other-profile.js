import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const params = new URLSearchParams(window.location.search);
const userID = params.get('id');
const backURL = params.get('back') || 'chats.html';

document.getElementById('backBtn').onclick = () => window.location.href = backURL;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'auth.html'; return; }

  try {
    const snap = await get(ref(db, 'users/' + userID));
    if (!snap.exists()) { alert('User not found.'); return; }

    const data = snap.val();
    const name = data.displayName || 'Unknown';

    document.getElementById('otherName').textContent = name;
    document.getElementById('otherID').textContent = userID + '@as';
    document.getElementById('otherAvatarPlaceholder').textContent = name.charAt(0).toUpperCase();

    if (data.photoURL) {
      const img = document.getElementById('otherAvatarImg');
      const placeholder = document.getElementById('otherAvatarPlaceholder');
      img.src = data.photoURL;
      img.style.display = 'block';
      placeholder.style.display = 'none';
    }
  } catch (err) {
    console.error(err);
  }
});

window.copyOtherID = function () {
  navigator.clipboard.writeText(userID + '@as').then(() => alert('ID copied!'));
}

