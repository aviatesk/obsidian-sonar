import { App, Modal, Notice, debounce } from 'obsidian';
import { mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { EmbeddingSearch, type SearchResult } from '../EmbeddingSearch';
import { ConfigManager } from '../ConfigManager';
import SemanticNoteFinderComponent from './SemanticNoteFinderComponent.svelte';
import type { Logger } from '../Logger';

interface SemanticSearchState {
  query: string;
  results: SearchResult[];
  isSearching: boolean;
  hasSearched: boolean;
}

export class SemanticNoteFinder extends Modal {
  private embeddingSearch: EmbeddingSearch;
  private configManager: ConfigManager;
  private logger: Logger;
  private svelteComponent:
    | ReturnType<typeof SemanticNoteFinderComponent>
    | undefined;
  private debouncedSearch: (query: string) => void;
  private searchStore = writable<SemanticSearchState>({
    query: '',
    results: [],
    isSearching: false,
    hasSearched: false,
  });

  constructor(
    app: App,
    embeddingSearch: EmbeddingSearch,
    configManager: ConfigManager,
    logger: Logger
  ) {
    super(app);
    this.embeddingSearch = embeddingSearch;
    this.configManager = configManager;
    this.logger = logger;

    this.debouncedSearch = debounce(
      this.handleSearch.bind(this),
      800, // Fixed debounce time for search
      true
    );
  }

  private updateStore(updates: Partial<SemanticSearchState>): void {
    this.searchStore.update(state => ({
      ...state,
      ...updates,
    }));
  }

  private async handleSearch(query: string): Promise<void> {
    if (!query.trim()) {
      this.updateStore({
        query: '',
        results: [],
        hasSearched: false,
      });
      return;
    }

    this.updateStore({
      query,
      isSearching: true,
      hasSearched: true,
    });

    try {
      const results = await this.embeddingSearch.search(
        query,
        this.configManager.get('topK'),
        {
          titleWeight: 0.5,
          contentWeight: 0.5,
        }
      );
      this.updateStore({
        results,
        isSearching: false,
      });
    } catch (err) {
      this.logger.error(`Search failed: ${err}`);
      new Notice('Search failed. Please check your settings.');
      this.updateStore({
        results: [],
        isSearching: false,
      });
    }
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    titleEl.empty();

    this.modalEl.addClass('semantic-search-modal');
    this.modalEl.style.width = '800px';
    this.modalEl.style.height = '600px';

    this.svelteComponent = mount(SemanticNoteFinderComponent, {
      target: contentEl,
      props: {
        app: this.app,
        store: this.searchStore,
        logger: this.logger,
        placeholder: 'Enter your search query...',
        titleEl: titleEl,
        onQueryChange: (query: string) => {
          this.updateStore({ query });
          if (query) {
            this.debouncedSearch(query);
          } else {
            this.updateStore({
              results: [],
              hasSearched: false,
            });
          }
        },
        onSearchImmediate: (query: string) => {
          this.handleSearch(query);
        },
        onClose: () => {
          this.close();
        },
      },
    });
  }

  onClose(): void {
    const { contentEl } = this;
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
    contentEl.empty();

    // Reset store on close
    this.updateStore({
      query: '',
      results: [],
      isSearching: false,
      hasSearched: false,
    });
  }
}
