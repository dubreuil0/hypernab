const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hypernabDesktop', Object.freeze({ settings: () => ipcRenderer.invoke('desktop:settings'), action: (command, value) => ipcRenderer.invoke('desktop:action', command, value) }));
