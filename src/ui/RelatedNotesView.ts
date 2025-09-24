import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownView,
  Notice,
  debounce,
} from 'obsidian';
import { mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { EmbeddingSearch, type SearchResult } from '../EmbeddingSearch';
import { QueryProcessor, type QueryOptions } from '../QueryProcessor';
import { ConfigManager } from '../ConfigManager';
import { Tokenizer } from '../Tokenizer';
import RelatedNotesContent from './RelatedNotesContent.svelte';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

interface RelatedNotesState {
  query: string;
  results: SearchResult[];
  tokenCount: number;
  status: string;
}

const relatedNotesStore = writable<RelatedNotesState>({
  query: '',
  results: [],
  tokenCount: 0,
  status: 'Ready to search',
});

export class RelatedNotesView extends ItemView {
  private embeddingSearch: EmbeddingSearch;
  private configManager: ConfigManager;
  private followCursor: boolean;
  private withExtraction: boolean;
  private isProcessing = false;
  private lastActiveFile: TFile | null = null;
  private debouncedRefresh: () => void;
  private svelteComponent: any;

  constructor(
    leaf: WorkspaceLeaf,
    embeddingSearch: EmbeddingSearch,
    configManager: ConfigManager
  ) {
    super(leaf);
    this.embeddingSearch = embeddingSearch;
    this.configManager = configManager;
    this.followCursor = configManager.get('followCursor');
    this.withExtraction = configManager.get('withExtraction');

    this.debouncedRefresh = debounce(
      this.refresh.bind(this),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.setupConfigListeners();
  }

  private setupConfigListeners(): void {
    this.configManager.subscribe('relatedNotesDebounceMs', (_, value) => {
      this.debouncedRefresh = debounce(this.refresh.bind(this), value, true);
    });

    this.configManager.subscribe('maxQueryTokens', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('embeddingModel', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('tokenizerModel', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('followCursor', (_, value) => {
      this.followCursor = value;
    });

    this.configManager.subscribe('withExtraction', (_, value) => {
      this.withExtraction = value;
    });
  }

  getViewType(): string {
    return RELATED_NOTES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Related Notes';
  }

  getIcon(): string {
    return 'links-coming-in';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('related-notes-view-container');

    // Mount component once with reactive props
    this.mountComponent();

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', async () => {
        await this.onActiveLeafChange();
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        this.debouncedRefresh();
      })
    );

    await this.onActiveLeafChange();
  }

  private mountComponent(): void {
    const container = this.containerEl.children[1];

    // Mount component once - it will subscribe to store changes
    this.svelteComponent = mount(RelatedNotesContent, {
      target: container,
      props: {
        app: this.app,
        configManager: this.configManager,
        store: relatedNotesStore,
        onRefresh: () => {
          this.manualRefresh();
        },
        onToggleFollowCursor: (value: boolean) => {
          this.followCursor = value;
          this.configManager.set('followCursor', value);
        },
        onToggleWithExtraction: (value: boolean) => {
          this.withExtraction = value;
          this.configManager.set('withExtraction', value);
        },
      },
    });
  }

  private updateStore(updates: Partial<RelatedNotesState>): void {
    relatedNotesStore.update(state => ({
      ...state,
      ...updates,
    }));
  }

  private async onActiveLeafChange(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (
      activeFile &&
      activeFile instanceof TFile &&
      activeFile !== this.lastActiveFile
    ) {
      this.lastActiveFile = activeFile;
      await this.refresh();
    } else if (!activeFile) {
      this.lastActiveFile = null;
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'No active note',
      });
    }
  }

  private async refresh(): Promise<void> {
    if (this.isProcessing) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !(activeFile instanceof TFile)) {
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'No active note',
      });
      return;
    }

    this.isProcessing = true;

    this.updateStore({ status: 'Processing...' });

    try {
      const content = await this.app.vault.cachedRead(activeFile);

      let cursorLine = 0;
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.editor) {
        const cursor = activeView.editor.getCursor();
        cursorLine = cursor.line;
      }

      const options: QueryOptions = {
        fileName: activeFile.basename,
        cursorLine: cursorLine,
        followCursor: this.followCursor,
        withExtraction: this.withExtraction,
        maxTokens: this.configManager.get('maxQueryTokens'),
        embeddingModel: this.configManager.get('embeddingModel'),
        tokenizerModel: this.configManager.get('tokenizerModel') || undefined,
        ollamaUrl: this.configManager.get('ollamaUrl'),
        summaryModel: this.configManager.get('summaryModel'),
      };

      const query = await QueryProcessor.process(content, options);

      if (query) {
        const tokenCount = await Tokenizer.estimateTokens(
          query,
          this.configManager.get('embeddingModel'),
          this.configManager.get('tokenizerModel') || undefined
        );
        const searchResults = await this.embeddingSearch.search(
          query,
          this.configManager.get('topK'),
          { excludeFilePath: activeFile.path }
        );
        this.isProcessing = false;
        this.updateStore({
          query: query,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'Ready to search',
        });
      }
    } catch (error) {
      console.error('Error refreshing related notes:', error);
      new Notice('Failed to retrieve related notes');
      this.isProcessing = false;
      this.updateStore({
        status: 'Failed to search',
        results: [],
      });
    }
  }

  private manualRefresh(): void {
    if (this.isProcessing) {
      new Notice('Processing in progress. Please wait.');
      return;
    }
    this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
  }
}
