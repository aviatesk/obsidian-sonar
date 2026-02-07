import { z } from 'zod';
import type { Tool } from '../Tool';
import type { SearchManager } from '../../SearchManager';
import { getState, checkSearchReady } from '../../SonarState';

export interface SearchVaultDependencies {
  getSearchManager: () => SearchManager | null;
}

const argsSchema = z.object({
  query: z.string(),
  max_results: z.number().optional().default(5),
});

export async function executeSearchVault(
  args: Record<string, unknown>,
  deps: SearchVaultDependencies
): Promise<string> {
  const searchManager = deps.getSearchManager();
  if (!searchManager) {
    return 'Error: Search is not available. Embedding model is still initializing.';
  }

  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: Invalid arguments: ${parsed.error.issues.map(i => i.message).join(', ')}`;
  }
  const { query, max_results: maxResults } = parsed.data;

  const chunks = await searchManager.getRerankedChunksForRAG(query, maxResults);

  if (chunks === null || chunks.length === 0) {
    return 'No relevant information found in the vault.';
  }

  const results: string[] = [];

  for (const chunk of chunks) {
    const notePath = chunk.filePath.replace(/\.md$/, '');
    const heading =
      chunk.metadata.headings?.length > 0
        ? chunk.metadata.headings[chunk.metadata.headings.length - 1]
        : null;

    const wikilink = heading
      ? `[[${notePath}#${heading.replace(/^#+\s*/, '')}]]`
      : `[[${notePath}]]`;

    results.push(`${wikilink}\n${chunk.content}`);
  }

  const separator1 =
    '=========================================================';
  const separator2 =
    '---------------------------------------------------------';
  return `
[Vault Search Results]

${separator1}

${results.join(`\n\n${separator2}\n\n`)}

${separator1}

IMPORTANT: ALWAYS include wikilinks \`[[Note name]]\` when using these information for the answer.
`;
}

export function createSearchVaultTool(deps: SearchVaultDependencies): Tool {
  return {
    definition: {
      name: 'search_vault',
      description:
        "Search the user's personal knowledge base (Obsidian vault) for relevant notes and information. " +
        'This should be your primary tool for answering questions about topics the user has written about. ' +
        'Use this first before resorting to web search.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find relevant notes',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
    displayName: 'Search vault',
    isBuiltin: true,
    execute: args => executeSearchVault(args, deps),
    getUnavailableReason: () => {
      const state = getState();
      if (state.embedder === 'failed') {
        return 'Embedder initialization failed. Run Reinitialize Sonar.';
      }
      if (state.metadataStore === 'failed') {
        return 'Metadata store initialization failed. Run Reinitialize Sonar.';
      }
      if (state.bm25Store === 'failed') {
        return 'BM25 store initialization failed. Run Reinitialize Sonar.';
      }
      if (!checkSearchReady(state)) {
        return 'Still initializing...';
      }
      const searchManager = deps.getSearchManager();
      return searchManager ? undefined : 'SearchManager not ready';
    },
  };
}
