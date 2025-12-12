<script lang="ts">
  import { App, Notice } from 'obsidian';
  import type { ConfigManager } from '../ConfigManager';
  import { STATUS_DISPLAY_TEXT, type RelatedNotesStatus } from './RelatedNotesView';
  import SearchResults from './SearchResults.svelte';
  import KnowledgeGraph from './KnowledgeGraph.svelte';
  import { RefreshCw, Eye, EyeOff, FileText, ChartNetwork, createElement } from 'lucide';
  import { onMount } from 'svelte';

  interface Props {
    app: App;
    configManager: ConfigManager;
    store: any; // Svelte store
    onRefresh: () => void;
  }

  let { app, configManager, store, onRefresh }: Props = $props();

  const storeState = $derived($store);
  const query = $derived(storeState.query);
  const results = $derived(storeState.results);
  const tokenCount = $derived(storeState.tokenCount);
  const status = $derived(storeState.status as RelatedNotesStatus);
  const statusText = $derived(STATUS_DISPLAY_TEXT[status]);
  const activeFile = $derived(storeState.activeFile);
  const hasQuery = $derived(query && query.trim().length > 0);
  let showQuery = $state(configManager.get('showRelatedNotesQuery'));
  let showExcerpts = $state(configManager.get('showRelatedNotesExcerpts'));
  let showKnowledgeGraph = $state(configManager.get('showKnowledgeGraph'));
  let refreshIcon: HTMLElement;
  let eyeIcon: HTMLElement;
  let excerptIcon: HTMLElement;
  let graphIcon: HTMLElement;

  // eyeIcon needs $effect because it changes reactively with showQuery state
  $effect(() => {
    if (eyeIcon) {
      const icon = createElement(showQuery ? Eye : EyeOff);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      eyeIcon.replaceChildren(icon);
    }
  });

  // Static icons only need onMount
  onMount(() => {
    if (refreshIcon) {
      const icon = createElement(RefreshCw);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      refreshIcon.appendChild(icon);
    }

    if (excerptIcon) {
      const icon = createElement(FileText);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      excerptIcon.appendChild(icon);
    }

    if (graphIcon) {
      const icon = createElement(ChartNetwork);
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      // eslint-disable-next-line svelte/no-dom-manipulating
      graphIcon.appendChild(icon);
    }
  });

  function handleRefresh() {
    if (status === 'processing') {
      new Notice('Processing in progress. Please wait.');
      return;
    }
    onRefresh();
  }

  function handleToggleQuery() {
    showQuery = !showQuery;
    configManager.set('showRelatedNotesQuery', showQuery);
  }

  function handleToggleExcerpts() {
    showExcerpts = !showExcerpts;
    configManager.set('showRelatedNotesExcerpts', showExcerpts);
  }

  function handleToggleGraph() {
    showKnowledgeGraph = !showKnowledgeGraph;
    configManager.set('showKnowledgeGraph', showKnowledgeGraph);
  }
</script>

<div class="related-notes-view">
  <div class="related-notes-header">
    <div class="status-container">
      <div class="status-indicator">
        {#if status === 'processing'}
          <span class="spinner"></span>
        {/if}
        <span>{statusText}</span>
      </div>

      <div class="controls-container">
        <button
          class="icon-button toggle-query-btn"
          class:active={showQuery}
          aria-label="Toggle search query visibility"
          onclick={handleToggleQuery}
        >
          <span bind:this={eyeIcon}></span>
        </button>

        <button
          class="icon-button toggle-excerpts-btn"
          class:active={showExcerpts}
          aria-label="Toggle result excerpts visibility"
          onclick={handleToggleExcerpts}
        >
          <span bind:this={excerptIcon}></span>
        </button>

        <button
          class="icon-button toggle-graph-btn"
          class:active={showKnowledgeGraph}
          aria-label="Toggle knowledge graph visibility"
          onclick={handleToggleGraph}
        >
          <span bind:this={graphIcon}></span>
        </button>

        <button
          class="icon-button refresh-button"
          aria-label="Refresh search results"
          onclick={handleRefresh}
        >
          <span bind:this={refreshIcon}></span>
        </button>
      </div>
    </div>
  </div>

  <div class="related-notes-content">
    {#if hasQuery && showQuery}
      <div class="current-query">
        <div class="query-header">
          <h4>Search Query</h4>
          <span class="query-length">{`${tokenCount} tokens`}</span>
        </div>
        <div class="query-text">
          {query}
        </div>
      </div>
    {/if}

    {#if activeFile && results.length > 0 && showKnowledgeGraph}
      <div class="knowledge-graph-section">
        <div class="graph-header">
          <h4>Knowledge Graph</h4>
        </div>
        <div class="graph-container">
          <KnowledgeGraph {app} {activeFile} {results} maxNodes={10} />
        </div>
      </div>
    {/if}

    {#if hasQuery}
      <div class="related-notes-results">
        <SearchResults
          {app}
          {results}
          {configManager}
          noResultsMessage="No related notes found"
          maxHeight="200px"
          showExcerpts={showExcerpts}
        />
      </div>
    {:else}
      <div class="empty-state">
        <span>{statusText}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .related-notes-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .related-notes-header {
    padding: 12px 16px;
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .status-container {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--background-modifier-border);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .controls-container {
    display: flex;
    gap: 6px;
  }

  .icon-button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .icon-button:hover {
    background: var(--background-primary);
    border-color: var(--background-modifier-border);
    color: var(--text-normal);
  }

  .icon-button.active {
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .icon-button.active:hover {
    background: var(--interactive-accent-hover);
    border-color: var(--interactive-accent-hover);
  }

  .related-notes-content {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 0;
  }

  .current-query {
    margin: 0 12px;
    padding: 12px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
  }

  .query-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .query-header h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .query-length {
    font-size: 10px;
    padding: 2px 6px;
    background: var(--background-modifier-border);
    color: var(--text-muted);
    border-radius: 4px;
  }

  .query-text {
    font-size: 12px;
    color: var(--text-normal);
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
    line-height: 1.5;
    padding-right: 8px;
  }

  .query-text::-webkit-scrollbar {
    width: 6px;
  }

  .query-text::-webkit-scrollbar-track {
    background: transparent;
  }

  .query-text::-webkit-scrollbar-thumb {
    background: var(--background-modifier-border);
    border-radius: 3px;
  }

  .query-text::-webkit-scrollbar-thumb:hover {
    background: var(--text-muted);
  }

  .related-notes-results {
    flex: 1;
    overflow-y: auto;
    margin: 0 12px;
  }

  .knowledge-graph-section {
    margin: 0 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--background-secondary);
    flex-shrink: 0;
  }

  .graph-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .graph-header h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .graph-container {
    padding: 12px;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    margin: 0 12px;
    padding: 24px;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
