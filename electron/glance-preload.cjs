const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glance", {
  act: (act) => ipcRenderer.invoke("glance-visor:act", act),
  size: (size) => ipcRenderer.invoke("glance-visor:size", size),
});
