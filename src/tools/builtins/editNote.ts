import { z } from 'zod';
import { type App, TFile } from 'obsidian';
import type { Tool } from '../Tool';
import type { ConfigManager } from '../../ConfigManager';

export interface EditNoteDependencies {
  app: App;
  configManager: ConfigManager;
}

const operationEnum = z.enum(['create', 'overwrite', 'append', 'prepend']);

const argsSchema = z.object({
  note: z.string(),
  operation: operationEnum,
  content: z.string(),
  folder: z.string().optional(),
});

/**
 * Resolve a note reference to a TFile using Obsidian's native APIs
 */
function resolveNote(app: App, note: string): TFile | null {
  const noteWithoutSection = note.split('#')[0].trim();
  const file = app.metadataCache.getFirstLinkpathDest(noteWithoutSection, '');
  if (file && file instanceof TFile && file.extension === 'md') {
    return file;
  }
  return null;
}

/**
 * Ensure folder exists, creating it if necessary
 */
async function ensureFolder(app: App, folder: string): Promise<void> {
  const folderExists = app.vault.getAbstractFileByPath(folder);
  if (!folderExists) {
    try {
      await app.vault.createFolder(folder);
    } catch {
      // Folder might have been created concurrently, ignore
    }
  }
}

/**
 * Build file path from note name and optional folder
 * If note already contains a path (has '/'), folder is ignored
 */
function buildFilePath(note: string, folder?: string): string {
  // If note already contains a path, use it directly
  if (note.includes('/')) {
    return note.endsWith('.md') ? note : `${note}.md`;
  }
  const filename = note.endsWith('.md') ? note : `${note}.md`;
  return folder ? `${folder}/${filename}` : filename;
}

export async function executeEditNote(
  args: Record<string, unknown>,
  deps: EditNoteDependencies
): Promise<string> {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return `Error: Invalid arguments: ${parsed.error.issues.map(i => i.message).join(', ')}`;
  }
  const { note, operation, content, folder } = parsed.data;

  const existingFile = resolveNote(deps.app, note);

  switch (operation) {
    case 'create': {
      if (existingFile) {
        const wikilink = existingFile.path.replace(/\.md$/, '');
        return `Error: Note [[${wikilink}]] already exists. Use 'overwrite' to replace its content, or 'append'/'prepend' to add content.`;
      }
      const filePath = buildFilePath(note, folder);
      if (folder) {
        await ensureFolder(deps.app, folder);
      }
      let createdFile: TFile;
      try {
        createdFile = await deps.app.vault.create(filePath, content);
      } catch (error) {
        return `Failed to create note: ${error instanceof Error ? error.message : String(error)}`;
      }
      const wikilink = createdFile.path.replace(/\.md$/, '');
      return (
        `[Note Created]\nCreated [[${wikilink}]]\n` +
        `Do not output full content - user can view the note directly. Just briefly confirm what was done.`
      );
    }

    case 'overwrite': {
      if (existingFile) {
        try {
          await deps.app.vault.modify(existingFile, content);
        } catch (error) {
          return `Failed to overwrite note: ${error instanceof Error ? error.message : String(error)}`;
        }
        const wikilink = existingFile.path.replace(/\.md$/, '');
        return (
          `[Note Overwritten]\nReplaced content of [[${wikilink}]]\n` +
          `Do not output full content - user can view the note directly. Just briefly confirm what was done.`
        );
      }
      // Create new note if it doesn't exist
      const filePath = buildFilePath(note, folder);
      if (folder) {
        await ensureFolder(deps.app, folder);
      }
      let createdFile: TFile;
      try {
        createdFile = await deps.app.vault.create(filePath, content);
      } catch (error) {
        return `Failed to create note: ${error instanceof Error ? error.message : String(error)}`;
      }
      const wikilink = createdFile.path.replace(/\.md$/, '');
      return (
        `[Note Created]\nCreated [[${wikilink}]]\n` +
        `Do not output full content - user can view the note directly. Just briefly confirm what was done.`
      );
    }

    case 'append': {
      if (!existingFile) {
        return `Error: Note "${note}" not found. Use 'create' or 'overwrite' operation to create a new note.`;
      }
      try {
        await deps.app.vault.append(existingFile, '\n\n' + content);
      } catch (error) {
        return `Failed to append to note: ${error instanceof Error ? error.message : String(error)}`;
      }
      const wikilink = existingFile.path.replace(/\.md$/, '');
      return (
        `[Content Appended]\nAppended to [[${wikilink}]]\n` +
        `Do not output full content - user can view the note directly. Just briefly confirm what was done.`
      );
    }

    case 'prepend': {
      if (!existingFile) {
        return `Error: Note "${note}" not found. Use 'create' or 'overwrite' operation to create a new note.`;
      }
      let existingContent: string;
      try {
        existingContent = await deps.app.vault.cachedRead(existingFile);
      } catch (error) {
        return `Failed to read note: ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        await deps.app.vault.modify(
          existingFile,
          content + '\n\n' + existingContent
        );
      } catch (error) {
        return `Failed to prepend to note: ${error instanceof Error ? error.message : String(error)}`;
      }
      const wikilink = existingFile.path.replace(/\.md$/, '');
      return (
        `[Content Prepended]\nPrepended to [[${wikilink}]]\n` +
        `Do not output full content - user can view the note directly. Just briefly confirm what was done.\n` +
        `IMPORTANT: ALWAYS include wikilinks \`[[${wikilink}]]\` in the final answer.`
      );
    }
  }
}

export function createEditNoteTool(deps: EditNoteDependencies): Tool {
  return {
    definition: {
      name: 'edit_note',
      description:
        'Edit a note in the vault. Only use this when the user **explicitly** requests editing/saving. ' +
        'If the user asks to "translate", "summarize", etc. without mentioning editing, return the result in your response instead.\n' +
        'IMPORTANT: Always use read_file first to check if the note exists.\n' +
        'Choose operation based on read_file result:\n' +
        '- Note not found → use "create" or "overwrite"\n' +
        '- Note exists, add content → use "append" or "prepend"\n' +
        '- Note exists, replace all → use "overwrite"\n' +
        'Operations:\n' +
        '- "create": New note only (fails if exists)\n' +
        '- "overwrite": Replace content or create if not exists\n' +
        '- "append": Add to end\n' +
        '- "prepend": Add to beginning',
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description:
              'The note title (e.g., "Meeting Notes") or vault-relative path (e.g., "folder/note")',
          },
          operation: {
            type: 'string',
            enum: ['create', 'overwrite', 'append', 'prepend'],
            description:
              'Operation type:\n' +
              '- create: New note only (error if exists)\n' +
              '- overwrite: Replace all content (creates if needed)\n' +
              '- append: Add to end of note\n' +
              '- prepend: Add to beginning of note',
          },
          content: {
            type: 'string',
            description: 'The content to write (markdown format)',
          },
          folder: {
            type: 'string',
            description:
              'Optional folder path for create/overwrite. Ignored if note already contains a path.',
          },
        },
        required: ['note', 'operation', 'content'],
      },
    },
    displayName: 'Edit note',
    isBuiltin: true,
    requiresPermission: !deps.configManager.get('editNoteAutoAllow'),
    execute: args => executeEditNote(args, deps),
  };
}
