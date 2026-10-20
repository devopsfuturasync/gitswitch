const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  i18n: ipcRenderer.sendSync('i18n:get'),
  // Calls a main-process handler; throws with its message on failure.
  async call(name, ...args) {
    const res = await ipcRenderer.invoke(name, ...args);
    if (!res.ok) {
      const err = new Error(res.error);
      err.detail = res.detail;
      err.kind = res.kind;
      throw err;
    }
    return res.value;
  },
  onFocus(fn) {
    ipcRenderer.on('window:focus', () => fn());
  },
  onProgress(fn) {
    ipcRenderer.on('progress', (_e, p) => fn(p));
  },
  onUpdate(fn) {
    ipcRenderer.on('update:state', (_e, s) => fn(s));
  },
  onStoreError(fn) {
    ipcRenderer.on('store:error', (_e, message) => fn(message));
  },
});
