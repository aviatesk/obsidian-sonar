import { App, FuzzySuggestModal, TFile } from 'obsidian';

interface RecentFilesPluginData {
  recentFiles?: { basename: string; path: string }[];
}

function getRecentFilePaths(app: App): Set<string> {
  // Try Recent Files plugin first (provides more entries)
  const recentFilesPlugin = (
    app as App & {
      plugins?: {
        plugins?: {
          'recent-files-obsidian'?: { data?: RecentFilesPluginData };
        };
      };
    }
  ).plugins?.plugins?.['recent-files-obsidian'];
  const pluginRecentFiles = recentFilesPlugin?.data?.recentFiles;
  if (pluginRecentFiles && pluginRecentFiles.length > 0) {
    return new Set(pluginRecentFiles.map(f => f.path));
  }

  // Fallback to standard API (limited to 10 files)
  return new Set(app.workspace.getLastOpenFiles());
}

/**
 * Modal for fuzzy file selection
 * Returns the selected file's name suitable for wikilink insertion
 */
export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private onSelect: (file: TFile) => void;

  constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.onSelect = onSelect;
    this.setPlaceholder('Select a file to reference...');
  }

  getItems(): TFile[] {
    const recentPaths = getRecentFilePaths(this.app);
    const recent: TFile[] = [];
    const others: TFile[] = [];
    for (const file of this.files) {
      if (recentPaths.has(file.path)) {
        recent.push(file);
      } else {
        others.push(file);
      }
    }
    return [...recent, ...others];
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile): void {
    this.onSelect(file);
  }
}

/**
 * Get the wikilink text for a file
 * Uses vault-relative path without extension for unambiguous references
 */
export function getWikilinkForFile(file: TFile): string {
  return file.path.replace(/\.md$/, '');
}
