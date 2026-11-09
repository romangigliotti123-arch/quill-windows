import { contextBridge, ipcRenderer } from 'electron';

/// The quick-note bubble's only door: it is told to start a fresh note, and it
/// reports what its textarea holds. Nothing else.
contextBridge.exposeInMainWorld('quillBubble', {
  onReset(handler: () => void): void {
    ipcRenderer.on('bubble:reset', () => handler());
  },
  textChanged(text: string): void {
    ipcRenderer.send('bubble:text', text);
  },
});
