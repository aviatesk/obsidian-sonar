import { App, Modal, Notice, debounce } from 'obsidian';
import { mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { SearchManager, type SearchResult } from '../SearchManager';
import { ConfigManager } from '../ConfigManager';
import SemanticNoteFinderComponent from './SemanticNoteFinderComponent.svelte';

interface SemanticSearchState {
  query: string;
  results: SearchResult[];
  isSearching: boolean;
  hasSearched: boolean;
}

const COMPONENT_ID = 'SemanticNoteFinder';

export class SemanticNoteFinder extends Modal {
  private searchManager: SearchManager;
  private configManager: ConfigManager;
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
  private searchAbortController: AbortController | null = null;
  private cache = {
    lastQuery: '',
    results: new Map<string, SearchResult[]>(),
  };

  constructor(
    app: App,
    searchManager: SearchManager,
    configManager: ConfigManager
  ) {
    super(app);
    this.searchManager = searchManager;
    this.configManager = configManager;

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
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }

    const trimmedQuery = query.trim();

    this.cache.lastQuery = trimmedQuery;

    if (!trimmedQuery) {
      this.updateStore({
        query: '',
        results: [],
        isSearching: false,
        hasSearched: false,
      });
      return;
    }

    const cachedResults = this.cache.results.get(trimmedQuery);
    if (cachedResults) {
      const topK = this.configManager.get('searchResultsCount');
      this.updateStore({
        query,
        results: cachedResults.slice(0, topK),
        isSearching: false,
        hasSearched: true,
      });
      return;
    }

    this.searchAbortController = new AbortController();
    const searchAbortSignal = this.searchAbortController.signal;

    this.updateStore({
      query,
      isSearching: true,
      hasSearched: true,
    });

    try {
      const results = await this.searchManager.search(
        COMPONENT_ID,
        trimmedQuery,
        {
          topK: this.configManager.get('searchResultsCount'),
          titleWeight: 0.25,
          contentWeight: 0.75,
        }
      );

      // Skip if superseded (null from queue) or aborted (new search started)
      if (results === null || searchAbortSignal.aborted) {
        return;
      }

      this.cache.results.set(trimmedQuery, results);

      this.updateStore({
        results,
        isSearching: false,
      });
    } catch (err) {
      if (searchAbortSignal.aborted) {
        return;
      }
      this.configManager.getLogger().error(`Search failed: ${err}`);
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

    // Restore last query from cache if available
    if (this.cache.lastQuery) {
      const cachedResults = this.cache.results.get(this.cache.lastQuery);
      const topK = this.configManager.get('searchResultsCount');
      this.updateStore({
        query: this.cache.lastQuery,
        results: cachedResults?.slice(0, topK) ?? [],
        hasSearched: !!cachedResults,
        isSearching: false,
      });
    }

    this.svelteComponent = mount(SemanticNoteFinderComponent, {
      target: contentEl,
      props: {
        app: this.app,
        store: this.searchStore,
        configManager: this.configManager,
        placeholder: 'Enter your search query...',
        titleEl: titleEl,
        onQueryChange: (query: string) => {
          this.updateStore({ query });
          this.debouncedSearch(query);
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
    // Cancel queued requests (in-flight search continues to populate cache)
    this.searchManager.cancelPendingRequests(COMPONENT_ID);

    const { contentEl } = this;
    if (this.svelteComponent) {
      unmount(this.svelteComponent);
    }
    contentEl.empty();

    // Reset store on close (cachedState is preserved for next open)
    this.updateStore({
      query: '',
      results: [],
      isSearching: false,
      hasSearched: false,
    });
  }

  invalidateCache(): void {
    this.cache.results.clear();
  }
}
