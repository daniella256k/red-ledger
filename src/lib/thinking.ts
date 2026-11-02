/** Joins a reply's separate stretches of thinking (one per model round) in its stored text. */
export const THINKING_BLOCK_SEPARATOR = '\n\n---\n\n'

/** A reply's stored thinking split back into its stretches, in order. */
export function splitThinkingBlocks(thinking: string | undefined): string[] {
  if (!thinking) return []
  return thinking.split(THINKING_BLOCK_SEPARATOR)
}
