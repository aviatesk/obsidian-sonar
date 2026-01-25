import { z } from 'zod';
import { requestUrl } from 'obsidian';
import type { Tool } from '../Tool';

export interface WebSearchDependencies {
  searxngUrl: string;
}

const argsSchema = z.object({
  query: z.string(),
  max_results: z.number().optional().default(5),
});

interface SearxngResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
}

interface SearxngResponse {
  results: SearxngResult[];
  query: string;
  number_of_results?: number;
}

export async function executeWebSearch(
  args: Record<string, unknown>,
  deps: WebSearchDependencies
): Promise<string> {
  if (!deps.searxngUrl) {
    return 'Web search is not configured. Please set the SearXNG URL in settings.';
  }
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: Invalid arguments: ${parsed.error.issues.map(i => i.message).join(', ')}`;
  }
  const { query, max_results: maxResults } = parsed.data;
  const searchUrl = new URL('/search', deps.searxngUrl);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('format', 'json');

  let response: SearxngResponse;
  try {
    const result = await requestUrl({
      url: searchUrl.toString(),
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    response = result.json as SearxngResponse;
  } catch (error) {
    return `Failed to search: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!response.results || response.results.length === 0) {
    return `No results found for "${query}".`;
  }

  const results = response.results.slice(0, maxResults);
  const formatted = results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`];
      if (r.content) {
        lines.push(`   ${r.content}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return (
    `[Web Search Results for "${query}"]\n` +
    `(Cite sources using markdown links: [Title](URL). ` +
    `If snippets lack detail, use fetch_url to get full page content.)\n` +
    `\n${formatted}`
  );
}

export function createWebSearchTool(deps: WebSearchDependencies): Tool {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web for current information. ' +
        'Use this when you need up-to-date information that may not be in the vault, ' +
        'such as recent news, current events, or external references. ' +
        'Also consider using this as a fallback when vault search does not yield relevant results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
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
    displayName: 'Web search',
    isBuiltin: true,
    execute: args => executeWebSearch(args, deps),
  };
}
