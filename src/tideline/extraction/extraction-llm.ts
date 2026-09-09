/** Host-supplied completion callback; the engine does not create model sessions. */
export type ExtractionLlm = (conversationText: string) => Promise<string>;
