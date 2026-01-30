import { z } from 'zod';
import type { Tool } from '../Tool';
import type { SearchManager } from '../../SearchManager';
import { getState } from '../../SonarModelState';

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

  return (
    '[Vault Search Results]\n' +
    '(Reference notes using wikilinks: [[Note name]])\n\n' +
    results.join('\n\n')
  );
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
    isAvailable: () => {
      const state = getState();
      if (state.embedder === 'failed') {
        return 'Initialization failed. Run Reinitialize Sonar.';
      }
      if (
        state.embedder === 'initializing' ||
        state.embedder === 'uninitialized'
      ) {
        return 'Still initializing...';
      }
      const searchManager = deps.getSearchManager();
      return searchManager ? null : 'SearchManager not ready';
    },
  };
}
