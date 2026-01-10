import type {
  LlamaCppChat,
  ChatMessage,
  ChatStreamDelta,
} from './LlamaCppChat';
import type {
  ChatContextBuilder,
  ChatContext,
  ExplicitReference,
} from './ChatContextBuilder';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';

const SYSTEM_PROMPT_BASE = `You are a helpful assistant.
Always respond in the same language as the user's question.`;

const SYSTEM_PROMPT_WITH_CONTEXT_INTRO = `You are an assistant that answers questions based on the user's notes.
Use the following context to answer the question.
Always respond in the same language as the user's question.
When referencing information from the context, include the source using the exact wikilink format shown (e.g., [[Note name]] or [[Note name#Section]]).
If you cannot find relevant information in the context, say so honestly.`;

const EXPLICIT_REFS_EXPLANATION = `[Explicit References] contains notes explicitly specified by the user via [[wikilink]] syntax. These should be treated as primary sources for answering the question.`;

const RETRIEVED_CONTEXT_EXPLANATION = `[Context] was retrieved using semantic search and reranked by relevance.
Items are ordered from most to least relevant, but:
- Not all items may be directly relevant to the question
- The answer may not be contained in the context at all`;

/**
 * Chat turn with user message and assistant response
 */
export interface ChatTurn {
  userMessage: string;
  assistantMessage: string;
  context?: ChatContext;
  explicitRefs?: ExplicitReference[];
}

/**
 * Chat session with optional context retrieval
 * Manages context window and conversation history
 */
export class Chat extends WithLogging {
  protected readonly componentName = 'Chat';

  private history: ChatTurn[] = [];
  private slotId: number;
  private readonly maxContextTokens = 28000;

  constructor(
    private chatModel: LlamaCppChat,
    private contextBuilder: ChatContextBuilder,
    protected configManager: ConfigManager,
    slotId: number = 0
  ) {
    super();
    this.slotId = slotId;
  }

  /**
   * Build messages array for the chat API with token budget management
   */
  private async buildMessages(
    currentUserMessage: string,
    currentContext?: ChatContext,
    explicitRefs?: ExplicitReference[]
  ): Promise<ChatMessage[]> {
    const maxSystemPrompt =
      SYSTEM_PROMPT_WITH_CONTEXT_INTRO +
      EXPLICIT_REFS_EXPLANATION +
      RETRIEVED_CONTEXT_EXPLANATION;
    const systemPromptTokens =
      await this.chatModel.countTokens(maxSystemPrompt);

    const currentMsgTokens =
      await this.chatModel.countTokens(currentUserMessage);

    let availableBudget =
      this.maxContextTokens - systemPromptTokens - currentMsgTokens;

    const currentContextTokens = currentContext?.totalTokens ?? 0;
    availableBudget -= currentContextTokens;

    const includedTurns: Array<{
      turn: ChatTurn;
      includeContext: boolean;
      tokens: number;
    }> = [];

    for (let i = this.history.length - 1; i >= 0; i--) {
      const turn = this.history[i];
      const turnMsgTokens = await this.estimateTurnTokens(turn);
      const turnContextTokens = turn.context?.totalTokens ?? 0;

      if (availableBudget >= turnMsgTokens + turnContextTokens) {
        includedTurns.unshift({
          turn,
          includeContext: true,
          tokens: turnMsgTokens + turnContextTokens,
        });
        availableBudget -= turnMsgTokens + turnContextTokens;
      } else if (availableBudget >= turnMsgTokens) {
        includedTurns.unshift({
          turn,
          includeContext: false,
          tokens: turnMsgTokens,
        });
        availableBudget -= turnMsgTokens;
      } else {
        this.log(`Trimming ${i + 1} older turns due to context window limit`);
        break;
      }
    }

    const contextsToInclude: string[] = [];
    for (const { turn, includeContext } of includedTurns) {
      if (includeContext && turn.context?.formattedContext) {
        contextsToInclude.push(turn.context.formattedContext);
      }
    }
    if (currentContext?.formattedContext) {
      contextsToInclude.push(currentContext.formattedContext);
    }

    const formattedExplicitRefs =
      explicitRefs && explicitRefs.length > 0
        ? this.contextBuilder.formatExplicitReferences(explicitRefs)
        : '';

    const hasExplicitRefs = formattedExplicitRefs.length > 0;
    const hasRetrievedContext = contextsToInclude.length > 0;
    const hasAnyContext = hasExplicitRefs || hasRetrievedContext;

    let systemContent = hasAnyContext
      ? SYSTEM_PROMPT_WITH_CONTEXT_INTRO
      : SYSTEM_PROMPT_BASE;

    if (hasExplicitRefs) {
      systemContent += `\n\n${EXPLICIT_REFS_EXPLANATION}`;
    }
    if (hasRetrievedContext) {
      systemContent += `\n\n${RETRIEVED_CONTEXT_EXPLANATION}`;
    }

    if (hasExplicitRefs) {
      systemContent += `\n\n[Explicit References]\n${formattedExplicitRefs}`;
    }

    if (hasRetrievedContext) {
      systemContent += `\n\n[Context]\n${contextsToInclude.join('\n\n')}`;
    }

    const messages: ChatMessage[] = [];
    messages.push({ role: 'system', content: systemContent });

    for (const { turn } of includedTurns) {
      messages.push({ role: 'user', content: turn.userMessage });
      messages.push({ role: 'assistant', content: turn.assistantMessage });
    }

    messages.push({ role: 'user', content: currentUserMessage });

    const explicitRefsCount = explicitRefs?.length ?? 0;
    this.log(
      `Built messages: ${includedTurns.length}/${this.history.length} turns, ${contextsToInclude.length} contexts, ${explicitRefsCount} explicit refs`
    );

    return messages;
  }

  /**
   * Estimate token count for a turn
   */
  private async estimateTurnTokens(turn: ChatTurn): Promise<number> {
    const msgTokens = await this.chatModel.countTokens(
      turn.userMessage + turn.assistantMessage
    );
    return msgTokens;
  }

  /**
   * Send a message and stream the response
   */
  async chatStream(
    userMessage: string,
    onDelta: (delta: ChatStreamDelta) => void,
    onContextReady?: () => void,
    signal?: AbortSignal
  ): Promise<string> {
    this.log(`Received message (streaming): "${userMessage.slice(0, 50)}..."`);

    const explicitRefs =
      await this.contextBuilder.getExplicitReferences(userMessage);

    let turnContext: ChatContext | undefined;

    if (this.configManager.get('ragEnableContext')) {
      const tokenBudget = this.configManager.get('ragContextTokenBudget');
      turnContext = await this.contextBuilder.buildContext(
        userMessage,
        tokenBudget
      );
      this.log(
        `Built context with ${turnContext.chunks.length} chunks, ${turnContext.totalTokens} tokens`
      );
    }

    onContextReady?.();

    const messages = await this.buildMessages(
      userMessage,
      turnContext,
      explicitRefs
    );
    const maxTokens = this.configManager.get('chatMaxTokens');
    const enableThinking = this.configManager.get('chatEnableThinking');

    let fullResponse = '';
    const usage = await this.chatModel.chatStream(
      messages,
      {
        maxTokens,
        idSlot: this.slotId,
        enableThinking,
      },
      delta => {
        fullResponse += delta.content;
        onDelta(delta);
      },
      undefined,
      signal
    );

    this.log(
      `Streaming complete: ${usage.totalTokens} tokens (prompt: ${usage.promptTokens}, completion: ${usage.completionTokens})`
    );

    this.history.push({
      userMessage,
      assistantMessage: fullResponse,
      context: turnContext,
      explicitRefs: explicitRefs.length > 0 ? explicitRefs : undefined,
    });

    return fullResponse;
  }

  /**
   * Get conversation history
   */
  getHistory(): ChatTurn[] {
    return [...this.history];
  }

  /**
   * Delete a specific turn from history
   */
  deleteTurn(index: number): void {
    if (index < 0 || index >= this.history.length) {
      this.warn(`Invalid turn index: ${index}`);
      return;
    }
    this.log(`Deleting turn at index ${index}`);
    this.history.splice(index, 1);
  }

  /**
   * Truncate history to a specific index (exclusive)
   */
  truncateHistory(fromIndex: number): void {
    if (fromIndex < 0 || fromIndex > this.history.length) {
      this.warn(`Invalid truncate index: ${fromIndex}`);
      return;
    }
    this.log(`Truncating history from index ${fromIndex}`);
    this.history = this.history.slice(0, fromIndex);
  }

  /**
   * Clear conversation history
   */
  clear(): void {
    this.log('Clearing conversation');
    this.history = [];
  }

  /**
   * Check if chat model is ready
   */
  isReady(): boolean {
    return this.chatModel.isReady();
  }
}
