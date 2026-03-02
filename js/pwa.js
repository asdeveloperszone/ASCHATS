/**
 * pwa.js — Install prompt handler
 * Shows an install button in chats header when browser fires beforeinstallprompt.
 * Also handles auth.html redirect when already logged in.
 */

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  hideInstallButton();
});

function showInstallButton() {
  const btn = document.getElementById('installAppBtn');
  if (btn) {
    btn.style.display = 'flex';
    btn.classList.add('install-btn-pop');
  }
}

function hideInstallButton() {
  const btn = document.getElementById('installAppBtn');
  if (btn) btn.style.display = 'none';
}

window.installApp = async function () {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (outcome === 'accepted') hideInstallButton();
};
