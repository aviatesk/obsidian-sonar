import { z } from 'zod';
import { type App, TFile } from 'obsidian';
import type { Tool } from '../Tool';
import type { MetadataStore } from '../../MetadataStore';

export interface ReadFileDependencies {
  app: App;
  getMetadataStore: () => MetadataStore | null;
}

const argsSchema = z.object({
  file: z.string(),
});

/**
 * Resolve a file path to a TFile using Obsidian's native APIs
 */
function resolveFile(app: App, file: string): TFile | null {
  const fileWithoutSection = file.split('#')[0].trim();
  const resolved = app.metadataCache.getFirstLinkpathDest(
    fileWithoutSection,
    ''
  );
  if (resolved && resolved instanceof TFile) {
    return resolved;
  }
  return null;
}

export async function executeReadFile(
  args: Record<string, unknown>,
  deps: ReadFileDependencies
): Promise<string> {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: Invalid arguments: ${parsed.error.issues.map(i => i.message).join(', ')}`;
  }
  const { file } = parsed.data;

  const resolvedFile = resolveFile(deps.app, file);

  // For markdown files, read directly from vault
  if (resolvedFile?.extension === 'md') {
    let content: string;
    try {
      content = await deps.app.vault.cachedRead(resolvedFile);
    } catch (error) {
      return `Failed to read file: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (!content.trim()) {
      return `File "${file}" is empty.`;
    }

    const wikilink = resolvedFile.path.replace(/\.md$/, '');
    return (
      `[File Content: ${resolvedFile.path}]\n` + `[[${wikilink}]]\n\n${content}`
    );
  }

  // For non-markdown files, try to get indexed content from MetadataStore
  const metadataStore = deps.getMetadataStore();
  if (metadataStore) {
    // Try with the resolved path first, then the original input
    const pathsToTry = resolvedFile
      ? [resolvedFile.path, file]
      : [file, `${file}.pdf`];

    for (const path of pathsToTry) {
      const chunks = await metadataStore.getChunksByFile(path);
      if (chunks.length > 0) {
        // Sort by page number (for PDFs) or chunk index
        const sortedChunks = chunks.sort((a, b) => {
          if (a.pageNumber !== undefined && b.pageNumber !== undefined) {
            return a.pageNumber - b.pageNumber;
          }
          // Fall back to id-based sorting (id format: filePath#chunkIndex)
          const aIndex = parseInt(a.id.split('#')[1] || '0', 10);
          const bIndex = parseInt(b.id.split('#')[1] || '0', 10);
          return aIndex - bIndex;
        });

        const content = sortedChunks.map(c => c.content).join('\n\n');
        const fileType = path.split('.').pop()?.toUpperCase() || 'FILE';

        return (
          `[File Content: ${path}]\n` +
          `(Extracted text from indexed ${fileType} file)\n\n${content}`
        );
      }
    }
  }

  if (resolvedFile) {
    return `File "${resolvedFile.path}" exists but is not indexed. Only markdown files can be read directly; other file types (PDF, etc.) must be indexed first.`;
  }
  return `File "${file}" not found in the vault.`;
}

export function createReadFileTool(deps: ReadFileDependencies): Tool {
  return {
    definition: {
      name: 'read_file',
      description:
        'Read the content of a file by its title or path.\n' +
        '- Markdown files (.md): Read directly from vault\n' +
        '- PDF and other indexed files: Read extracted text from index\n' +
        'Use this to check file content before editing, or when user references a file.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description:
              'The file title or vault-relative path (e.g., "Meeting Notes", "folder/document.pdf")',
          },
        },
        required: ['file'],
      },
    },
    displayName: 'Read file',
    isBuiltin: true,
    execute: args => executeReadFile(args, deps),
  };
}
