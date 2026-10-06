const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  sendFiles: (peerId, files) => ipcRenderer.invoke('send-files', { peerId, files }),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  showFile: id => ipcRenderer.invoke('show-file', id),
  copyText: text => ipcRenderer.invoke('copy-text', text)
});
