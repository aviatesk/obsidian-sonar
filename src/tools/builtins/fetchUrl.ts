import { z } from 'zod';
import { requestUrl } from 'obsidian';
import type { Tool } from '../Tool';

const argsSchema = z.object({
  url: z.string(),
});

export function extractTextFromHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc
    .querySelectorAll('script, style, nav, header, footer, aside, noscript')
    .forEach(el => el.remove());
  const text = doc.body?.textContent?.trim() ?? '';
  return text.replace(/\s+/g, ' ');
}

export async function executeFetchUrl(
  args: Record<string, unknown>
): Promise<string> {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: Invalid arguments: ${parsed.error.issues.map(i => i.message).join(', ')}`;
  }
  const { url } = parsed.data;

  let html: string;
  try {
    const response = await requestUrl({ url });
    html = response.text;
  } catch (error) {
    return `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`;
  }

  const text = extractTextFromHtml(html);
  if (!text) {
    return `No text content found at ${url}.`;
  }

  const maxLength = 8000;
  const truncated =
    text.length > maxLength ? text.slice(0, maxLength) + '\n[truncated]' : text;

  return (
    `[Content from ${url}]\n` +
    `(Cite using markdown link: [Title](${url}))\n\n${truncated}`
  );
}

export interface FetchUrlDependencies {
  enabled: boolean;
}

export function createFetchUrlTool(deps: FetchUrlDependencies): Tool {
  return {
    definition: {
      name: 'fetch_url',
      description:
        'Fetch and extract text content from a web page. ' +
        'Use this when the user provides a URL or references a web page.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
        },
        required: ['url'],
      },
    },
    displayName: 'Fetch URL',
    isBuiltin: true,
    defaultDisabled: !deps.enabled,
    execute: executeFetchUrl,
  };
}
