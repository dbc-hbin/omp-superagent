/** Keep the real backend selected without inference, downloads, or automatic memory work. */
export const offlineMnemopi = {
  memory: { backend: "mnemopi" },
  mnemopi: { llmMode: "none", noEmbeddings: true, autoRecall: false, autoRetain: false },
} as const;
