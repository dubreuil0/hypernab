const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hypernabDesktop', Object.freeze({ settings: () => ipcRenderer.invoke('desktop:settings'), action: (command, value) => ipcRenderer.invoke('desktop:action', command, value),
  // links found in the clipboard (only when the user turned that on): a list of plain address strings
  onClipboard: callback => { if (typeof callback === 'function') ipcRenderer.on('desktop:clipboard', (_event, links) => { if (Array.isArray(links)) callback(links.filter(link => typeof link === 'string').slice(0, 100)); }); } }));
