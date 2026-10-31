// Voice input (docs/design.md §9 语音输入): only the interface for now.
// Weiqi: leave a slot, build it later. The composer shows a disabled mic
// button while `voiceInput.available` is false. A real recognizer (the OS
// speech API through Rust, or a model service) implements SpeechInput and
// replaces `voiceInput`; the composer then inserts what it hears.

export interface SpeechInput {
  /** Whether this device can listen at all (false = the button stays disabled). */
  readonly available: boolean;
  /**
   * Starts listening. `onText` gets the running transcript (`final` once a
   * sentence is done); resolves when listening has started.
   */
  start(onText: (text: string, final: boolean) => void, opts?: { lang?: string }): Promise<void>;
  /** Stops listening; resolves with the full transcript. */
  stop(): Promise<string>;
}

/** Nothing yet: not available, and starting fails. */
export const noSpeech: SpeechInput = {
  available: false,
  start: () => Promise.reject(new Error('语音输入以后上线')),
  stop: () => Promise.resolve(''),
};

export let voiceInput: SpeechInput = noSpeech;

/** Swaps in a recognizer (for the later implementation and for tests). */
export function setVoiceInput(v: SpeechInput) {
  voiceInput = v;
}
