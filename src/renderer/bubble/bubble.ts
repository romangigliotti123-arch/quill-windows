/// The quick-note bubble's renderer: a textarea that tells the main process
/// what it currently holds, so the note can be saved when the dictation ends.

declare global {
  interface Window {
    quillBubble: {
      onReset(handler: () => void): void;
      textChanged(text: string): void;
    };
  }
}

const field = document.getElementById('text') as HTMLTextAreaElement;

field.addEventListener('input', () => { window.quillBubble.textChanged(field.value); });

// A fresh note: clear and take focus. Called each time the bubble is shown,
// because the window is reused.
window.quillBubble.onReset(() => {
  field.value = '';
  window.quillBubble.textChanged('');
  field.focus();
});

export {};
