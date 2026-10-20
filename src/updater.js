// Checks GitHub Releases for a newer GitSwitch, downloads it in the
// background and installs it when the user restarts (or quits) the app.
const { app } = require('electron');

const CHECK_EVERY = 4 * 60 * 60 * 1000;

let autoUpdater = null;
let autoDownload = true;
let state = { state: 'idle', version: app.getVersion() };

function setup(send) {
  const update = (next) => {
    state = { ...state, ...next };
    send(state);
  };
  if (!app.isPackaged) {
    state = { ...state, state: 'dev' };
    return;
  }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = autoDownload;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => update({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => update({ state: 'latest' }));
  autoUpdater.on('update-available', (info) => update({ state: autoDownload ? 'downloading' : 'available', next: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => update({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => update({ state: 'ready', next: info.version }));
  autoUpdater.on('error', (err) => update({ state: 'error', message: err.message }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, CHECK_EVERY);
}

async function check() {
  if (!autoUpdater) return state;
  await autoUpdater.checkForUpdates();
  return state;
}

// With auto-download off, an available update waits for the user to ask.
function setAutoDownload(on) {
  autoDownload = on;
  if (autoUpdater) autoUpdater.autoDownload = on;
}

function download() {
  if (autoUpdater && state.state === 'available') autoUpdater.downloadUpdate().catch(() => {});
}

function install() {
  // Silent install, then start the new version.
  if (autoUpdater && state.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

module.exports = { setup, check, install, download, setAutoDownload, status: () => state };
