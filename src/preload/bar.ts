import { contextBridge, ipcRenderer } from 'electron';

/// The always-on bar's only door: it receives its layout and whether a
/// dictation is running, and it can report two clicks. It floats over every
/// other application on the machine, so it can do nothing else.
contextBridge.exposeInMainWorld('quillBar', {
  onConfig(handler: (config: { anchor: 'left' | 'center' | 'right'; showsNewNote: boolean }) => void): void {
    ipcRenderer.on('bar:config', (_event, config) => handler(config));
  },
  onActive(handler: (active: boolean) => void): void {
    ipcRenderer.on('bar:active', (_event, active: boolean) => handler(active));
  },
  toggle(): void { ipcRenderer.send('bar:toggle'); },
  newNote(): void { ipcRenderer.send('bar:newNote'); },
});
