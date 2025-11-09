// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    onServerPort: (callback) => ipcRenderer.on('server-port', (_, port) => callback(port))
});