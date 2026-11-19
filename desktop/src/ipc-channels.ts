// main と preload が共有する IPC のチャンネル名。
export const IPC = {
  engineRequest: 'studio-m:engine:request',
  fileOpen: 'studio-m:file:open',
  fileSave: 'studio-m:file:save',
} as const;
