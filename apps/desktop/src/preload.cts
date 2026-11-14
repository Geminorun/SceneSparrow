import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sceneSparrow", {
  health: () => ipcRenderer.invoke("project:health"),
  readProject: () => ipcRenderer.invoke("project:read"),
  createProject: (command: unknown) =>
    ipcRenderer.invoke("project:create", command),
});
