<script lang="ts">
  import { App, TFile } from 'obsidian';
  import type { SearchResult } from '../SearchManager';
  import { MarkdownRenderingManager } from './MarkdownRenderingManager';
  import { onDestroy } from 'svelte';
  import type { Logger } from '../Logger';

  interface Props {
    app: App;
    results: SearchResult[];
    logger: Logger;
    onFileClick?: (file: TFile) => void;
    noResultsMessage?: string;
    maxHeight?: string;
    maxLength?: number;
    showExcerpts?: boolean;
  }

  let {
    app,
    results = [],
    logger,
    onFileClick,
    noResultsMessage = 'No results found',
    maxHeight = '100px',
    maxLength = undefined,
    showExcerpts = true,
  }: Props = $props();

  const markdownManager = new MarkdownRenderingManager(app, logger, { maxLength });

  onDestroy(() => {
    markdownManager.cleanup();
  });

  function setExcerptElement(node: HTMLElement, index: number) {
    const result = results[index];
    if (result) {
      requestAnimationFrame(() => {
        if (node.parentElement) {
          node.empty();
          markdownManager.render(result.topChunk.content, node, result.filePath);
        }
      });
    }
    return {
      destroy() {
        markdownManager.cleanupElement(node);
      },
    };
  }

  async function handleTitleClick(result: SearchResult) {
    const file = app.vault.getAbstractFileByPath(result.filePath);
    if (file instanceof TFile) {
      if (onFileClick) {
        onFileClick(file);
      } else {
        await app.workspace.getLeaf(false).openFile(file);
      }
    }
  }

  function getDisplayTitle(result: SearchResult): string {
    return result.title || 'Untitled';
  }

  function getScorePercent(score: number): number {
    return Math.round(score * 100);
  }

</script>

{#if results.length === 0}
  <p class="no-results">{noResultsMessage}</p>
{:else}
  <div class="results-list">
    {#each results as result, index (`${result.filePath}-${index}`)}
      <div class="result-item">
        <div
          class="score-bar"
          style:--score-width="{getScorePercent(result.score)}%"
          data-score="{getScorePercent(result.score)}%"
        ></div>

        <div class="result-content">
          <div class="title-container">
            <button
              class="result-title"
              onclick={() => handleTitleClick(result)}
              type="button"
            >
              {getDisplayTitle(result)}
            </button>
            <div class="score-info">
              <span class="result-score" title="Similarity score">{result.score.toFixed(3)}</span>
              {#if result.chunkCount > 1}
                <span class="chunk-count">{result.chunkCount} chunks</span>
              {/if}
            </div>
          </div>

          <div class="result-path">{result.filePath}</div>

          {#if result.topChunk.metadata.headings && result.topChunk.metadata.headings.length > 0}
            <div class="result-headings">
              {result.topChunk.metadata.headings.join(' › ')}
            </div>
          {/if}

          {#if showExcerpts}
            <div
              class="result-excerpt"
              style:max-height={maxHeight}
              use:setExcerptElement={index}
            ></div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .no-results {
    color: var(--text-muted);
    text-align: center;
    padding: 20px;
  }

  .results-list {
    padding: 8px 0;
  }

  .result-item {
    position: relative;
    margin-bottom: 16px;
    border-radius: 8px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    transition: all 0.2s ease;
    overflow: hidden;
  }

  .result-item:hover {
    background: var(--background-secondary-alt);
    border-color: var(--interactive-accent);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .result-content {
    padding: 16px;
  }

  .score-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--background-modifier-border);
    border-radius: 8px 8px 0 0;
    overflow: hidden;
  }

  .score-bar::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    width: var(--score-width);
    background: linear-gradient(90deg, var(--interactive-accent), var(--interactive-accent-hover));
    transition: width 0.3s ease;
  }

  .title-container {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    min-width: 0;
  }

  .result-title {
    margin: 0;
    background: none;
    border: none;
    color: var(--text-normal);
    cursor: pointer;
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    justify-content: space-evenly;
    padding: 8;
  }

  .result-title:hover {
    text-decoration: underline;
  }

  .score-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .result-score {
    font-size: 12px;
    padding: 2px 8px;
    color: var(--text-muted);
    border-radius: 4px;
    border: 1px solid var(--interactive-accent);
    font-weight: 600;
  }

  .chunk-count {
    font-size: 8px;
    padding: 2px 8px;
    color: var(--text-muted);
    background: var(--background-modifier-border);
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .result-path {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 8px;
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-headings {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 8px;
    padding: 4px 0;
    border-bottom: 1px solid var(--background-modifier-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-excerpt {
    color: var(--text-normal);
    font-size: 13px;
    line-height: 1.6;
    margin-top: 8px;
    overflow-y: auto;
    padding: 8px;
    background: var(--background-primary);
    border-radius: 4px;
    border: 1px solid var(--background-modifier-border);
  }

  .result-excerpt::-webkit-scrollbar {
    width: 8px;
  }

  .result-excerpt::-webkit-scrollbar-track {
    background: transparent;
  }

  .result-excerpt::-webkit-scrollbar-thumb {
    background: var(--background-modifier-border);
    border-radius: 3px;
  }

  .result-excerpt::-webkit-scrollbar-thumb:hover {
    background: var(--text-muted);
  }
</style>
