import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { ref, get, update } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

let myID = null;
let newPhotoBase64 = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'auth.html'; return; }

  myID = localStorage.getItem('aschat_userID');
  const name = localStorage.getItem('aschat_name') || user.displayName || '';

  document.getElementById('nameInput').value = name;
  document.getElementById('heroName').textContent = name;
  document.getElementById('heroID').textContent = myID + '@as';
  document.getElementById('idDisplay').textContent = myID + '@as';

  // Load avatar initial
  const initial = name.charAt(0).toUpperCase();
  document.getElementById('avatarPlaceholder').textContent = initial;

  // Load photo from Firebase
  try {
    const snap = await get(ref(db, 'users/' + myID));
    if (snap.exists()) {
      const data = snap.val();
      if (data.photoURL) {
        showPhoto(data.photoURL);
      }
    }
  } catch (err) {
    console.error(err);
  }
});

function showPhoto(url) {
  const img = document.getElementById('avatarImg');
  const placeholder = document.getElementById('avatarPlaceholder');
  img.src = url;
  img.style.display = 'block';
  placeholder.style.display = 'none';
}

window.handlePhotoChange = function (event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    newPhotoBase64 = e.target.result;
    showPhoto(newPhotoBase64);
  };
  reader.readAsDataURL(file);
}

window.copyMyID = function () {
  navigator.clipboard.writeText(myID + '@as').then(() => alert('ID copied!'));
}

window.saveProfile = async function () {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) { alert('Name cannot be empty.'); return; }

  try {
    const updates = { displayName: name };
    if (newPhotoBase64) updates.photoURL = newPhotoBase64;

    await update(ref(db, 'users/' + myID), updates);

    localStorage.setItem('aschat_name', name);
    if (newPhotoBase64) localStorage.setItem('aschat_photo', newPhotoBase64);

    document.getElementById('heroName').textContent = name;
    alert('Profile saved!');
    window.location.href = 'chats.html';
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

