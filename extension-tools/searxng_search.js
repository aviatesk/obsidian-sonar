/**
 * Extension tool: SearXNG Web Search
 *
 * Search the web using a self-hosted SearXNG instance.
 * SearXNG is a privacy-respecting metasearch engine that aggregates results
 * from multiple search engines without tracking.
 *
 * Setup:
 * 1. Install SearXNG (see README.md for Docker setup instructions)
 * 2. Set SEARXNG_URL below to your instance URL
 * 3. Enable the tool in the chat interface
 *
 * For detailed setup instructions, see the main README.md under
 * "Agentic assistant chat > Tools > Web search".
 */

// Replace with your SearXNG instance URL
const SEARXNG_URL = '';

/** @param {import('./types').ExtensionToolContext} ctx */
module.exports = function (ctx) {
  /** @type {import('./types').ExtensionTool} */
  const tool = {
    definition: {
      name: 'searxng_search',
      description:
        'Search the web for current information using SearXNG. ' +
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
          },
        },
        required: ['query'],
      },
    },
    displayName: 'SearXNG search',
    defaultDisabled: true,
    getUnavailableReason: () => {
      return SEARXNG_URL ? undefined : 'SearXNG URL not configured';
    },
    execute: async args => {
      if (!SEARXNG_URL) {
        return 'SearXNG URL is not configured. Please set SEARXNG_URL in the tool file.';
      }

      const query = args.query;
      const maxResults = args.max_results || 5;

      if (!query || typeof query !== 'string') {
        return 'Error: Invalid query parameter';
      }

      const searchUrl = new URL('/search', SEARXNG_URL);
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('format', 'json');

      let response;
      try {
        const result = await ctx.requestUrl({
          url: searchUrl.toString(),
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });
        response = result.json;
      } catch (error) {
        return `Failed to search: ${error.message || String(error)}`;
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
    },
  };
  return tool;
};
