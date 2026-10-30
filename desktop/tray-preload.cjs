const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hypernabTray', Object.freeze({
  command: (command, id) => ipcRenderer.invoke('tray:command', command, id),
  subscribe: callback => {
    if (typeof callback !== 'function') return;
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('tray:state', listener);
    return () => ipcRenderer.removeListener('tray:state', listener);
  }
}));
