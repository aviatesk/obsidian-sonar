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
import { SearchManager, type SearchResult } from '../SearchManager';
import { processQuery, type QueryOptions } from '../QueryProcessor';
import { ConfigManager } from '../ConfigManager';
import type { Embedder } from '../Embedder';
import { getCurrentContext } from '../Utils';
import RelatedNotesContent from './RelatedNotesContent.svelte';

export const RELATED_NOTES_VIEW_TYPE = 'related-notes-view';

interface RelatedNotesState {
  query: string;
  results: SearchResult[];
  tokenCount: number;
  status: string;
  isProcessing: boolean;
  activeFile: string | null;
}

export class RelatedNotesView extends ItemView {
  private searchManager: SearchManager;
  private configManager: ConfigManager;
  private embedder: Embedder;
  private lastActiveFile: TFile | null = null;
  private lastQuery: string = '';
  private debouncedRefresh: () => void;
  private debouncedCursorRefresh: () => void;
  private debouncedScrollRefresh: () => void;
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
    activeFile: null,
  });

  constructor(
    leaf: WorkspaceLeaf,
    searchManager: SearchManager,
    configManager: ConfigManager,
    embedder: Embedder,
    registerEditorExt: (ext: Extension) => void,
    registerMdPostProcessor: (processor: MarkdownPostProcessor) => void
  ) {
    super(leaf);
    this.searchManager = searchManager;
    this.configManager = configManager;
    this.embedder = embedder;
    this.registerEditorExt = registerEditorExt;
    this.registerMdPostProcessor = registerMdPostProcessor;

    this.debouncedRefresh = debounce(
      this.refresh.bind(this),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.debouncedCursorRefresh = debounce(
      () => this.refresh(true),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.debouncedScrollRefresh = debounce(
      () => this.refresh(false),
      configManager.get('relatedNotesDebounceMs'),
      true
    );

    this.setupConfigListeners();
  }

  private setupConfigListeners(): void {
    this.configManager.subscribe('relatedNotesDebounceMs', (_, value) => {
      this.debouncedRefresh = debounce(this.refresh.bind(this), value, true);
      this.debouncedCursorRefresh = debounce(
        () => this.refresh(true),
        value,
        true
      );
      this.debouncedScrollRefresh = debounce(
        () => this.refresh(false),
        value,
        true
      );
    });

    this.configManager.subscribe('maxQueryTokens', () => {
      this.debouncedRefresh();
    });

    this.configManager.subscribe('embeddingModel', () => {
      this.debouncedRefresh();
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
          this.debouncedCursorRefresh();
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
        this.debouncedCursorRefresh();
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
        onRefresh: () => {
          this.manualRefresh();
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
      if (activeView) {
        this.setupScrollListener(activeView);
      }

      await this.refresh(true);
    } else if (!activeFile) {
      this.lastActiveFile = null;
      this.lastQuery = '';
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'No active note',
        isProcessing: false,
        activeFile: null,
      });
    }
  }

  private setupScrollListener(view: MarkdownView): void {
    const readingEl = view.containerEl.querySelector(
      '.markdown-preview-view'
    ) as HTMLElement;
    const editingEl = view.containerEl.querySelector(
      '.cm-scroller'
    ) as HTMLElement;

    const handler = () => {
      this.debouncedScrollRefresh();
    };

    if (readingEl) readingEl.addEventListener('scroll', handler);
    if (editingEl) editingEl.addEventListener('scroll', handler);
    this.scrollUnsubscribe = () => {
      if (readingEl) readingEl.removeEventListener('scroll', handler);
      if (editingEl) editingEl.removeEventListener('scroll', handler);
    };
  }

  private async refresh(preferCursor: boolean = false): Promise<void> {
    if (get(this.relatedNotesStore).isProcessing) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !(activeFile instanceof TFile)) {
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'No active note',
        isProcessing: false,
        activeFile: null,
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

    const context = activeView
      ? getCurrentContext(activeView, preferCursor)
      : null;

    if (!context) {
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'Unable to determine position',
        isProcessing: false,
        activeFile: activeFile.path,
      });
      return;
    }

    const options: QueryOptions = {
      fileName: activeFile.basename,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      hasSelection: context.hasSelection,
      maxTokens: this.configManager.get('maxQueryTokens'),
      embedder: this.embedder,
    };

    try {
      const content = await this.app.vault.cachedRead(activeFile);
      const query = await processQuery(content, options);

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
        const tokenCount = await this.embedder.countTokens(query);
        const searchResults = await this.searchManager.searchUI(query, {
          excludeFilePath: activeFile.path,
        });
        this.updateStore({
          query: query,
          results: searchResults,
          tokenCount: tokenCount,
          status: 'Ready to search',
          isProcessing: false,
          activeFile: activeFile.path,
        });
      } else {
        this.updateStore({
          query: '',
          results: [],
          tokenCount: 0,
          status: 'No content to search',
          isProcessing: false,
          activeFile: activeFile.path,
        });
      }
    } catch (err) {
      this.configManager
        .getLogger()
        .error(`Error refreshing related notes: ${err}`);
      new Notice('Failed to retrieve related notes');
      this.updateStore({
        query: '',
        results: [],
        tokenCount: 0,
        status: 'Failed to search',
        isProcessing: false,
        activeFile: activeFile.path,
      });
    }
  }

  private manualRefresh(): void {
    if (get(this.relatedNotesStore).isProcessing) {
      new Notice('Processing in progress. Please wait.');
      return;
    }
    this.lastQuery = '';
    this.refresh(true);
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
