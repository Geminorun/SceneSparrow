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
  readSources: (after?: string) => ipcRenderer.invoke("sources:read", after),
  pickFileIntake: (id: string) => ipcRenderer.invoke("intake:pick", id),
  cancelFileSelection: (id: string) =>
    ipcRenderer.invoke("intake:pick-cancel", id),
  onFileIntakeProgress: (
    id: string,
    handler: (loaded: number, total: number) => void,
  ) => {
    const listener = (
      _event: unknown,
      received: string,
      loaded: number,
      total: number,
    ) => {
      if (received === id) handler(loaded, total);
    };
    ipcRenderer.on("intake:progress", listener);
    return () => ipcRenderer.removeListener("intake:progress", listener);
  },
  cancelIntake: (id: string) => ipcRenderer.invoke("intake:cancel", id),
  documentAction: (action: unknown) =>
    ipcRenderer.invoke("document:action", action),
  documentJob: (id: string) => ipcRenderer.invoke("document:job", id),
  extractionPage: (id: string, offset: number) =>
    ipcRenderer.invoke("source:extraction", id, offset),
  openExternalLink: (url: string) =>
    ipcRenderer.invoke("source:open-link", url),
  subscribeEvents: (handler: (event: unknown) => void, resync: () => void) => {
    const nonce = crypto.randomUUID();
    const listener = (
      _event: unknown,
      received: string,
      kind: string,
      data: unknown,
    ) => {
      if (received !== nonce) return;
      if (kind === "resync") resync();
      else if (kind === "event") handler(data);
    };
    ipcRenderer.on("project:event", listener);
    ipcRenderer.send("project:events-start", nonce);
    return () => {
      ipcRenderer.removeListener("project:event", listener);
      ipcRenderer.send("project:events-stop", nonce);
    };
  },
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
