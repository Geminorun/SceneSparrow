import { contextBridge, ipcRenderer } from "electron";

let closeHandler: () => Promise<boolean> = async () => true;
ipcRenderer.on("manuscript:close-request", async (_event, nonce: string) => {
  ipcRenderer.send("manuscript:close-progress", nonce);
  let allowed = false;
  try {
    allowed = await closeHandler();
  } catch {
    allowed = false;
  }
  ipcRenderer.send("manuscript:close-result", nonce, allowed);
});

contextBridge.exposeInMainWorld("sceneSparrow", {
  readHistory: () => ipcRenderer.invoke("manuscript:history"),
  readManuscript: () => ipcRenderer.invoke("manuscript:read"),
  executeManuscript: (command: unknown) =>
    ipcRenderer.invoke("manuscript:command", command),
  commandReceipt: (requestId: string) =>
    ipcRenderer.invoke("manuscript:receipt", requestId),
  onCloseRequested: (handler: () => Promise<boolean>) => {
    closeHandler = handler;
    return () => {
      if (closeHandler === handler) closeHandler = async () => true;
    };
  },
  health: () => ipcRenderer.invoke("project:health"),
  readProject: () => ipcRenderer.invoke("project:read"),
  createProject: (command: unknown) =>
    ipcRenderer.invoke("project:create", command),
});
