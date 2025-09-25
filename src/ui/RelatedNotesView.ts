import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownView,
  Notice,
  debounce,
} from 'obsidian';
import type {
  MarkdownPostProcessorContext,
  MarkdownPostProcessor,
} from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { mount, unmount } from 'svelte';
import { writable, get } from 'svelte/store';
import { EmbeddingSearch, type SearchResult } from '../EmbeddingSearch';
import {
  processQuery,
  extractWithLLM,
  type QueryOptions,
} from '../QueryProcessor';
import { ConfigManager } from '../ConfigManager';
import { Tokenizer } from '../Tokenizer';
import { getCurrentContext } from '../ObsidianUtils';
import RelatedNotesContent from './RelatedNotesContent.svelte';
import type { Logger } from '../Logger';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

interface RelatedNotesState {
  query: string;
  results: SearchResult[];
  tokenCount: number;
  status: string;
  isProcessing: boolean;
}

export class RelatedNotesView extends ItemView {
  private embeddingSearch: EmbeddingSearch;
  private configManager: ConfigManager;
  private getTokenizer: () => Tokenizer;
  private logger: Logger;
  private withExtraction: boolean;
  private lastActiveFile: TFile | null = null;
  private lastQuery: string = '';
  private debouncedRefresh: () => void;
  private debouncedPositionCheck: () => void;
  private svelteComponent: any;
  private scrollUnsubscribe: (() => void) | null = null;
  private registerEditorExt: (ext: Extension) => void;
  private registerMdPostProcessor: (processor: MarkdownPostProcessor) => void;
  private relatedNotesStore = writable<RelatedNotesState>({
    query: '',
    results: [],
    tokenCount: 0,
    status: 'Ready to search',
    isProcessing: false,
  });

  constructor(
    leaf: WorkspaceLeaf,
    embeddingSearch: EmbeddingSearch,
    configManager: ConfigManager,
    getTokenizer: () => Tokenizer,
    logger: Logger,
    registerEditorExt: (ext: Extension) => void,
    registerMdPostProcessor: (processor: MarkdownPostProcessor) => void
  ) {
    super(leaf);
    this.embeddingSearch = embeddingSearch;
    this.configManager = configManager;
    this.getTokenizer = getTokenizer;
    this.logger = logger;
    this.withExtraction = configManager.get('withExtraction');
    this.registerEditorExt = registerEditorExt;
    this.registerMdPostProcessor = registerMdPostProcessor;

    this.debouncedRefresh = debounce(
      this.refresh.bind(this),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.debouncedPositionCheck = debounce(
      this.handlePositionChange.bind(this),
      200,
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
    return 'radar';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('related-notes-view-container');

    // Mount component once with reactive props
    this.mountComponent();

    this.registerEditorExt(
      EditorView.updateListener.of(update => {
        if (update.selectionSet && !update.docChanged) {
          this.debouncedPositionCheck();
        }
      })
    );

    this.registerMdPostProcessor(
      (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const info = ctx.getSectionInfo(el);
        if (info) {
          el.dataset.lineStart = String(info.lineStart);
          el.dataset.lineEnd = String(info.lineEnd);
        }
      }
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', async () => {
        await this.onActiveLeafChange();
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        this.debouncedPositionCheck();
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
        store: this.relatedNotesStore,
        logger: this.logger,
        onRefresh: () => {
          this.manualRefresh();
        },
        onToggleWithExtraction: (value: boolean) => {
          this.withExtraction = value;
          this.configManager.set('withExtraction', value);
        },
      },
    });
  }

  private updateStore(newState: RelatedNotesState): void {
    this.relatedNotesStore.set(newState);
  }

  private async onActiveLeafChange(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();

    if (this.scrollUnsubscribe) {
      this.scrollUnsubscribe();
      this.scrollUnsubscribe = null;
    }

    if (
      activeFile &&
      activeFile instanceof TFile &&
      activeFile !== this.lastActiveFile
    ) {
      this.lastActiveFile = activeFile;
      this.lastQuery = '';

      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.getMode() === 'preview') {
        this.setupScrollListener(activeView);
      }

      await this.handlePositionChange();
    } else if (!activeFile) {
      this.lastActiveFile = null;
      this.lastQuery = '';
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'No active note',
        isProcessing: false,
      });
    }
  }

  private setupScrollListener(view: MarkdownView): void {
    const previewEl = view.containerEl.querySelector(
      '.markdown-preview-view'
    ) as HTMLElement;
    if (!previewEl) return;

    const handler = debounce(() => {
      this.debouncedPositionCheck();
    }, 200);

    previewEl.addEventListener('scroll', handler);
    this.scrollUnsubscribe = () => {
      previewEl.removeEventListener('scroll', handler);
    };
  }

  private async handlePositionChange(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (get(this.relatedNotesStore).isProcessing) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !(activeFile instanceof TFile)) {
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'No active note',
        isProcessing: false,
      });
      return;
    }

    const currentState = get(this.relatedNotesStore);
    this.updateStore({
      ...currentState,
      status: 'Processing...',
      isProcessing: true,
    });

    let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      const leaves = this.app.workspace.getLeavesOfType('markdown');
      activeView =
        (leaves.find(leaf => (leaf.view as MarkdownView).file === activeFile)
          ?.view as MarkdownView) || null;
    }

    const context = activeView ? getCurrentContext(activeView) : null;

    if (!context) {
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'Unable to determine position',
        isProcessing: false,
      });
      return;
    }

    const options: QueryOptions = {
      fileName: activeFile.basename,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      hasSelection: context.hasSelection,
      maxTokens: this.configManager.get('maxQueryTokens'),
      tokenizer: this.getTokenizer(),
    };

    try {
      const content = await this.app.vault.cachedRead(activeFile);
      let query = await processQuery(content, options);

      if (this.withExtraction) {
        query = await extractWithLLM(
          query,
          this.configManager.get('maxQueryTokens'),
          this.configManager.get('ollamaUrl'),
          this.configManager.get('summaryModel'),
          this.logger
        );
      }

      if (query === this.lastQuery) {
        const currentState = get(this.relatedNotesStore);
        this.updateStore({
          ...currentState,
          status: 'Ready to search',
          isProcessing: false,
        });
        return;
      }

      this.lastQuery = query;

      if (query) {
        const tokenCount = await this.getTokenizer().estimateTokens(query);
        const searchResults = await this.embeddingSearch.search(
          query,
          this.configManager.get('topK'),
          { excludeFilePath: activeFile.path }
        );
        this.updateStore({
          query: query,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'Ready to search',
          isProcessing: false,
        });
      } else {
        this.updateStore({
          query: '',
          results: [],
          tokenCount: 0,
          status: 'No content to search',
          isProcessing: false,
        });
      }
    } catch (err) {
      this.logger.error(`Error refreshing related notes: ${err}`);
      new Notice('Failed to retrieve related notes');
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'Failed to search',
        isProcessing: false,
      });
    }
  }

  private manualRefresh(): void {
    if (get(this.relatedNotesStore).isProcessing) {
      new Notice('Processing in progress. Please wait.');
      return;
    }
    this.lastQuery = '';
    this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.scrollUnsubscribe) {
      this.scrollUnsubscribe();
      this.scrollUnsubscribe = null;
    }
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
  }
}
