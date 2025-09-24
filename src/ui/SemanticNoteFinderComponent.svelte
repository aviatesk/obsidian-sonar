<script lang="ts">
  import { App } from 'obsidian';
  import SearchResults from './SearchResults.svelte';

  interface Props {
    app: App;
    store: any; // Svelte store
    placeholder?: string;
    onQueryChange: (query: string) => void;
    onSearchImmediate: (query: string) => void;
  }

  let {
    app,
    store,
    placeholder = 'Enter your search query...',
    onQueryChange,
    onSearchImmediate,
  }: Props = $props();

  // Get reactive state from store
  const storeState = $derived($store);
  const query = $derived(storeState.query);
  const results = $derived(storeState.results);
  const isSearching = $derived(storeState.isSearching);
  const hasSearched = $derived(storeState.hasSearched);

  let inputEl: HTMLInputElement;

  function handleInputChange(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    onQueryChange(value);
  }

  // Focus input on mount
  $effect(() => {
    if (inputEl) {
      inputEl.focus();
    }
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      const value = (event.target as HTMLInputElement).value;
      onSearchImmediate(value);
    }
  }
</script>

<div class="semantic-search-container">
  <div class="search-input-container">
    <input
      type="text"
      class="search-input"
      bind:this={inputEl}
      value={query}
      oninput={handleInputChange}
      onkeydown={handleKeydown}
      {placeholder}
    />
    {#if isSearching}
      <div class="search-status">
        <span class="spinner"></span>
        Searching...
      </div>
    {/if}
  </div>

  <div class="search-results-container">
    {#if hasSearched}
      <SearchResults
        {app}
        {results}
        noResultsMessage={isSearching ? 'Searching...' : 'No results found for your query'}
      />
    {/if}
  </div>
</div>

<style>
  .semantic-search-container {
    padding: 20px;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .search-input-container {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
  }

  .search-input {
    flex: 1;
    padding: 8px 32px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 14px;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
  }

  .search-status {
    padding: 8px 12px;
    color: var(--text-muted);
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-muted);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .search-results-container {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
</style>
