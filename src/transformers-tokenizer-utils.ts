import type { PreTrainedTokenizer } from '@huggingface/transformers/types/base/processing_utils';

/**
 * Count tokens in text using Transformers.js tokenizer
 *
 * Process line by line to avoid hanging on large texts.
 * Transformers.js tokenizer can hang when processing large texts (e.g., entire
 * file contents) in one call. By splitting into lines and processing each line
 * separately, we ensure responsiveness even for large documents.
 * Special tokens are excluded to get accurate token counts for the content itself.
 */
export async function countTokensTransformers(
  tokenizer: PreTrainedTokenizer,
  text: string
): Promise<number> {
  const lines = text.split('\n');
  let totalTokens = 0;
  for (const line of lines) {
    const { input_ids } = await tokenizer(line, {
      add_special_tokens: false,
    });
    totalTokens += Number(input_ids.size);
  }
  return totalTokens;
}

/**
 * Get token IDs from text using Transformers.js tokenizer
 *
 * Process line by line to avoid hanging on large texts.
 * Transformers.js tokenizer can hang when processing large texts in one call.
 * By processing line by line and aggregating results, we maintain responsiveness.
 * Special tokens are excluded since callers (e.g., BM25) need content tokens only.
 */
export function getTokenIdsTransformers(
  tokenizer: PreTrainedTokenizer,
  text: string
): number[] {
  const lines = text.split('\n');
  const allTokenIds: number[] = [];
  for (const line of lines) {
    const ids = tokenizer.encode(line, {
      add_special_tokens: false,
    });
    allTokenIds.push(...Array.from(ids));
  }
  return allTokenIds;
}
