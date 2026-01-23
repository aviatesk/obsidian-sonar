import type { SearchManager, ChunkResult } from './SearchManager';
import type { LlamaCppChat } from './LlamaCppChat';
import type { ConfigManager } from './ConfigManager';
import type { MetadataStore } from './MetadataStore';
import { WithLogging } from './WithLogging';

/**
 * Context chunk with provenance information
 */
export interface ContextChunk {
  content: string;
  filePath: string;
  title: string;
  heading: string | null;
  tokenCount: number;
}

/**
 * Built context ready for LLM consumption
 */
export interface ChatContext {
  chunks: ContextChunk[];
  formattedContext: string;
  totalTokens: number;
}

/**
 * Explicit reference from user input [[wikilink]]
 */
export interface ExplicitReference {
  wikilink: string;
  filePath: string;
  content: string;
}

/**
 * Builds chat context from search results and explicit references
 */
export class ChatContextBuilder extends WithLogging {
  protected readonly componentName = 'ChatContextBuilder';

  constructor(
    private searchManager: SearchManager,
    private chatModel: LlamaCppChat,
    private metadataStore: MetadataStore,
    protected configManager: ConfigManager
  ) {
    super();
  }

  /**
   * Build context for a query within token budget
   * @param query User's query
   * @param tokenBudget Maximum tokens to use for context
   * @param maxChunks Maximum number of chunks to include (default: 10)
   * @returns Chat context with formatted string and metadata
   */
  async buildContext(
    query: string,
    tokenBudget: number,
    maxChunks: number = 10
  ): Promise<ChatContext> {
    this.log(`Building context for query: "${query.slice(0, 50)}..."`);

    const chunks = await this.retrieveChunks(query, maxChunks);
    if (chunks.length === 0) {
      this.log('No relevant chunks found');
      return { chunks: [], formattedContext: '', totalTokens: 0 };
    }

    this.log(`Retrieved ${chunks.length} chunks, fitting to token budget`);
    return this.buildContextWithBudget(chunks, tokenBudget);
  }

  /**
   * Retrieve relevant chunks using hybrid search + reranking
   */
  private async retrieveChunks(
    query: string,
    maxChunks: number
  ): Promise<ChunkResult[]> {
    const chunks = await this.searchManager.getRerankedChunksForRAG(
      query,
      maxChunks
    );

    if (chunks === null) {
      this.warn('Reranker not ready, context unavailable');
      return [];
    }

    return chunks;
  }

  /**
   * Build context string within token budget
   */
  private async buildContextWithBudget(
    chunks: ChunkResult[],
    tokenBudget: number
  ): Promise<ChatContext> {
    const contextChunks: ContextChunk[] = [];
    let totalTokens = 0;

    for (const chunk of chunks) {
      const heading = this.extractHeading(chunk.metadata.headings);
      const formatted = this.formatChunk(
        chunk.content,
        chunk.metadata.title,
        heading,
        chunk.filePath
      );

      const tokenCount = await this.chatModel.countTokens(formatted);

      if (totalTokens + tokenCount > tokenBudget) {
        this.log(
          `Token budget reached at ${contextChunks.length} chunks (${totalTokens} tokens)`
        );
        break;
      }

      contextChunks.push({
        content: chunk.content,
        filePath: chunk.filePath,
        title: chunk.metadata.title,
        heading,
        tokenCount,
      });
      totalTokens += tokenCount;
    }

    const formattedContext = contextChunks
      .map(c => this.formatChunk(c.content, c.title, c.heading, c.filePath))
      .join('\n\n');

    this.log(
      `Built context with ${contextChunks.length} chunks, ${totalTokens} tokens`
    );

    return {
      chunks: contextChunks,
      formattedContext,
      totalTokens,
    };
  }

  /**
   * Extract the most specific heading from the headings array
   */
  private extractHeading(headings: string[]): string | null {
    if (!headings || headings.length === 0) {
      return null;
    }
    return headings[headings.length - 1];
  }

  /**
   * Format a chunk with provenance information
   */
  private formatChunk(
    content: string,
    title: string,
    heading: string | null,
    filePath?: string
  ): string {
    const linkText = this.getWikilinkText(title, filePath);
    const wikilink = heading
      ? `[[${linkText}#${this.stripHeadingPrefix(heading)}]]`
      : `[[${linkText}]]`;

    return `${wikilink}\n${content}`;
  }

  /**
   * Strip markdown heading prefix (e.g., "## Heading" -> "Heading")
   */
  private stripHeadingPrefix(heading: string): string {
    return heading.replace(/^#+\s*/, '');
  }

  /**
   * Get the appropriate text for a wikilink
   */
  private getWikilinkText(title: string, filePath?: string): string {
    if (!filePath) return title;

    const isMarkdown = filePath.toLowerCase().endsWith('.md');
    if (isMarkdown) {
      return title;
    }

    const parts = filePath.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Format explicit references for the system prompt
   */
  formatExplicitReferences(refs: ExplicitReference[]): string {
    if (refs.length === 0) return '';
    return refs
      .map(ref => {
        const linkText = this.getWikilinkText(ref.wikilink, ref.filePath);
        return `[[${linkText}]]\n${ref.content}`;
      })
      .join('\n\n');
  }

  /**
   * Parse wikilinks from a message
   */
  private parseWikilinks(message: string): string[] {
    const regex = /\[\[([^\]]+)\]\]/g;
    const matches: string[] = [];
    let match;
    while ((match = regex.exec(message)) !== null) {
      matches.push(match[1]);
    }
    return matches;
  }

  /**
   * Build file path lookup map from MetadataStore
   */
  private async buildFilePathMap(): Promise<Map<string, string>> {
    const chunks = await this.metadataStore.getAllChunks();
    const map = new Map<string, string>();
    const seenPaths = new Set<string>();

    for (const chunk of chunks) {
      const filePath = chunk.filePath;
      if (seenPaths.has(filePath)) {
        continue;
      }
      seenPaths.add(filePath);

      const parts = filePath.split('/');
      const filenameWithExt = parts[parts.length - 1];
      const filenameNoExt = filenameWithExt.replace(/\.md$/, '');

      map.set(filePath, filePath);
      map.set(filenameWithExt, filePath);
      if (filenameWithExt !== filenameNoExt) {
        map.set(filenameNoExt, filePath);
      }
    }

    return map;
  }

  /**
   * Resolve a wikilink to a file path
   */
  private async resolveWikilink(wikilink: string): Promise<string | null> {
    const map = await this.buildFilePathMap();
    const linkWithoutSection = wikilink.split('#')[0];

    if (map.has(linkWithoutSection)) {
      return map.get(linkWithoutSection)!;
    }

    const lowerLink = linkWithoutSection.toLowerCase();
    for (const [key, value] of map.entries()) {
      if (key.toLowerCase() === lowerLink) {
        return value;
      }
    }

    return null;
  }

  /**
   * Get content for explicit references in user message
   */
  async getExplicitReferences(message: string): Promise<ExplicitReference[]> {
    const wikilinks = this.parseWikilinks(message);
    if (wikilinks.length === 0) {
      return [];
    }

    const refs: ExplicitReference[] = [];
    for (const wikilink of wikilinks) {
      const filePath = await this.resolveWikilink(wikilink);
      if (!filePath) {
        this.warn(`Could not resolve wikilink: [[${wikilink}]]`);
        continue;
      }

      const chunks = await this.metadataStore.getChunksByFile(filePath);
      if (chunks.length === 0) {
        this.warn(`No content found for: ${filePath}`);
        continue;
      }

      chunks.sort((a, b) => a.id.localeCompare(b.id));
      const content = chunks.map(c => c.content).join('\n\n');
      refs.push({ wikilink, filePath, content });
    }

    this.log(`Resolved ${refs.length}/${wikilinks.length} explicit references`);
    return refs;
  }
}
