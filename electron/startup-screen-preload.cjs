const { contextBridge, ipcRenderer } = require("electron");

// This loading page has no app bridge, credentials or file access.
contextBridge.exposeInMainWorld("startupScreen", {
  close: () => ipcRenderer.send("startup-screen:close"),
  onProgress: (listener) => {
    if (typeof listener !== "function") return;
    ipcRenderer.on("startup-screen:progress", (_event, state) => listener({
      step: typeof state?.step === "string" ? state.step : null,
      finished: state?.finished === true,
    }));
  },
});
