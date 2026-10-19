const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Calls a main-process handler; throws with its message on failure.
  async call(name, ...args) {
    const res = await ipcRenderer.invoke(name, ...args);
    if (!res.ok) throw new Error(res.error);
    return res.value;
  },
  onFocus(fn) {
    ipcRenderer.on('window:focus', () => fn());
  },
});
