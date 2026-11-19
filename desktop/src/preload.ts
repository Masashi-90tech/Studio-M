// preload（サンドボックス内で動く）。renderer には window.studioMPro だけを見せる。合言葉は渡さない。
import { contextBridge, ipcRenderer } from 'electron';
import type { StudioMApi } from './api';
import { IPC } from './ipc-channels';

const api: StudioMApi = {
  engine: { request: (req) => ipcRenderer.invoke(IPC.engineRequest, req) },
  file: {
    open: () => ipcRenderer.invoke(IPC.fileOpen),
    save: (req) => ipcRenderer.invoke(IPC.fileSave, req),
  },
};

contextBridge.exposeInMainWorld('studioMPro', api);
