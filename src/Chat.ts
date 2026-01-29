import type {
  LlamaCppChat,
  ChatMessageExtended,
  ChatStreamDelta,
  ToolCall,
} from './LlamaCppChat';
import type { ConfigManager } from './ConfigManager';
import type { ToolRegistry, Tool, ToolPermissionRequest } from './tools';
import { WithLogging } from './WithLogging';

// TODO: Consider replacing static date injection with a self-reflection tool
// that allows the model to query current date/time and other context as needed.
function getSystemPrompt(tools: Tool[]): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  if (tools.length === 0) {
    return `You are a helpful assistant.
Today is ${today}.
Always respond in the same language as the user's question.`;
  }

  // Build tool descriptions dynamically
  const toolDescriptions = tools
    .map(t => `- ${t.definition.name}: ${t.definition.description}`)
    .join('\n');

  return `You are an assistant that helps users with their notes and tasks.
Today is ${today}.

You have access to the following tools:
${toolDescriptions}

Guidelines:
- Use tools to gather information before answering questions.
- If initial results are insufficient, try different search queries or parameters.
- You can call the same tool multiple times or combine multiple tools.
- Before editing a note, ALWAYS use read_file first to check if it exists and understand its current content. This helps you choose the correct operation (create/overwrite/append/prepend).
- Tool results include status info (e.g., [Iteration 2/5, context budget: 4000/8192 tokens remaining]). Once you have enough information to answer the question, stop calling tools and respond immediately. If the context budget is low, additional tool calls may be truncated.
- Do not answer with incomplete information. If you cannot find what you need after multiple attempts, say so honestly.
- Always respond in the same language as the user's question.`;
}

/**
 * Chat turn with user message and assistant response
 */
export interface ChatTurn {
  userMessage: string;
  assistantMessage: string;
}

/**
 * Chat session with agentic tool calling
 * Model autonomously calls tools to gather information
 */
export class Chat extends WithLogging {
  protected readonly componentName = 'Chat';

  private history: ChatTurn[] = [];
  private slotId: number;
  private readonly maxContextTokens = 28000;

  constructor(
    private chatModel: LlamaCppChat,
    private toolRegistry: ToolRegistry,
    protected configManager: ConfigManager,
    slotId: number = 0
  ) {
    super();
    this.slotId = slotId;
  }

  /**
   * Get the tool registry for external access (e.g., UI)
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Build messages array for the chat API with token budget management
   */
  private async buildMessages(
    currentUserMessage: string,
    enabledTools: Tool[]
  ): Promise<ChatMessageExtended[]> {
    const systemPrompt = getSystemPrompt(enabledTools);
    const systemPromptTokens = await this.chatModel.countTokens(systemPrompt);
    const currentMsgTokens =
      await this.chatModel.countTokens(currentUserMessage);

    let availableBudget =
      this.maxContextTokens - systemPromptTokens - currentMsgTokens;

    const includedTurns: ChatTurn[] = [];

    for (let i = this.history.length - 1; i >= 0; i--) {
      const turn = this.history[i];
      const turnTokens = await this.chatModel.countTokens(
        turn.userMessage + turn.assistantMessage
      );

      if (availableBudget >= turnTokens) {
        includedTurns.unshift(turn);
        availableBudget -= turnTokens;
      } else {
        this.log(`Trimming ${i + 1} older turns due to context window limit`);
        break;
      }
    }

    const messages: ChatMessageExtended[] = [];
    messages.push({ role: 'system', content: systemPrompt });

    for (const turn of includedTurns) {
      messages.push({ role: 'user', content: turn.userMessage });
      messages.push({ role: 'assistant', content: turn.assistantMessage });
    }

    messages.push({ role: 'user', content: currentUserMessage });

    this.log(
      `Built messages: ${includedTurns.length}/${this.history.length} turns included`
    );

    return messages;
  }

  /**
   * Execute a single tool call and return the result
   */
  private async executeToolCall(toolCall: ToolCall): Promise<string> {
    const { name, arguments: argsJson } = toolCall.function;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      const error = `Error: Failed to parse tool arguments: ${argsJson}`;
      this.warn(error);
      return error;
    }

    const result = await this.toolRegistry.execute(name, args);
    if (result === null) {
      const error = `Error: Tool '${name}' not found`;
      this.warn(error);
      return error;
    }

    if (result.startsWith('Error:') || result.startsWith('Failed')) {
      this.warn(`Tool ${name}: ${result}`);
    }

    return result;
  }

  /**
   * Truncate content to fit within a token budget
   * Uses character-based estimation (4 chars ≈ 1 token)
   */
  private truncateToTokenBudget(content: string, maxTokens: number): string {
    if (maxTokens <= 0) {
      return '[Content too large for context window]';
    }

    // Estimate: 4 characters per token (conservative for mixed content)
    const estimatedMaxChars = maxTokens * 4;

    if (content.length <= estimatedMaxChars) {
      return content;
    }

    // Leave room for the truncation notice
    const truncationNotice = '\n\n[truncated due to context limit]';
    const availableChars = estimatedMaxChars - truncationNotice.length;

    if (availableChars <= 0) {
      return '[Content too large for context window]';
    }

    // Try to truncate at a line boundary for cleaner output
    const truncated = content.slice(0, availableChars);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > availableChars * 0.8) {
      return truncated.slice(0, lastNewline) + truncationNotice;
    }

    return truncated + truncationNotice;
  }

  /**
   * Send a message and stream the response with agent loop for tool calling
   *
   * @param userMessage - The user's message
   * @param onDelta - Callback for streaming text content
   * @param onToolCall - Callback for tool call status updates
   * @param onPermissionRequest - Callback to request user permission for tools
   * @param signal - Optional AbortSignal for cancellation
   * @returns The final response content
   */
  async chatStream(
    userMessage: string,
    onDelta: (delta: ChatStreamDelta) => void,
    onToolCall?: (toolName: string, phase: 'calling' | 'done') => void,
    onPermissionRequest?: (request: ToolPermissionRequest) => Promise<boolean>,
    signal?: AbortSignal
  ): Promise<string> {
    this.log(`Received message (streaming): "${userMessage.slice(0, 50)}..."`);

    const enabledTools = this.toolRegistry.getEnabled();
    const openAITools = this.toolRegistry.getOpenAITools();

    const messages = await this.buildMessages(userMessage, enabledTools);

    const maxTokens = this.configManager.get('chatMaxTokens');
    const enableThinking = this.configManager.get('chatEnableThinking');
    const toolResultsBudget = this.configManager.get('contextTokenBudget');
    const maxIterations = this.configManager.get('agentMaxIterations');

    let fullResponse = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let toolResultsTokensUsed = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      this.log(`Agent loop iteration ${iteration + 1}/${maxIterations}`);

      const response = await this.chatModel.chatStream(
        messages,
        openAITools,
        {
          maxTokens,
          idSlot: this.slotId,
          enableThinking,
        },
        onDelta,
        signal
      );

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;

      // If no tool calls, we have the final response
      if (!response.toolCalls || response.toolCalls.length === 0) {
        fullResponse = response.content;
        break;
      }

      // Execute each tool call
      this.log(`Model requested ${response.toolCalls.length} tool call(s)`);

      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: response.content || undefined,
        tool_calls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.function.name;
        const tool = this.toolRegistry.get(toolName);
        this.log(
          `Executing tool: ${toolName}, args: ${toolCall.function.arguments}`
        );
        onToolCall?.(toolName, 'calling');

        let result: string;

        if (tool?.requiresPermission && onPermissionRequest) {
          const args = JSON.parse(toolCall.function.arguments) as Record<
            string,
            unknown
          >;
          const permitted = await onPermissionRequest({
            toolName,
            displayName: tool.displayName,
            args,
          });

          // Check if aborted during permission request
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          if (!permitted) {
            this.log(`Permission denied for tool: ${toolName}`);
            result = `Permission denied: User did not allow ${tool.displayName}.`;
          } else {
            result = await this.executeToolCall(toolCall);
          }
        } else {
          result = await this.executeToolCall(toolCall);
        }

        const resultTokens = await this.chatModel.countTokens(result);
        const remainingBudget = toolResultsBudget - toolResultsTokensUsed;

        if (resultTokens > remainingBudget) {
          this.log(
            `Tool ${toolName} result (${resultTokens} tokens) exceeds remaining budget (${remainingBudget}), truncating`
          );
          result = this.truncateToTokenBudget(result, remainingBudget);
        }

        const finalTokens = await this.chatModel.countTokens(result);
        toolResultsTokensUsed += finalTokens;
        this.log(
          `Tool ${toolName} returned ${result.length} chars (${finalTokens} tokens, total: ${toolResultsTokensUsed}/${toolResultsBudget})`
        );
        onToolCall?.(toolName, 'done');

        // Add tool result to conversation with iteration and budget info
        const budgetRemaining = toolResultsBudget - toolResultsTokensUsed;
        const statusInfo =
          `[Iteration ${iteration + 1}/${maxIterations}, ` +
          `context budget: ${budgetRemaining}/${toolResultsBudget} tokens remaining]\n`;
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: statusInfo + result,
        });
      }
    }

    // If we exhausted iterations without a final response, do one more call without tools
    if (!fullResponse) {
      this.log(
        'Max iterations reached, generating final response without tools'
      );
      const finalResponse = await this.chatModel.chatStream(
        messages,
        [], // No tools - force a text response
        {
          maxTokens,
          idSlot: this.slotId,
          enableThinking,
        },
        onDelta,
        signal
      );
      fullResponse = finalResponse.content;
      totalPromptTokens += finalResponse.usage.promptTokens;
      totalCompletionTokens += finalResponse.usage.completionTokens;
    }

    const totalTokens = totalPromptTokens + totalCompletionTokens;
    this.log(
      `Agent loop complete: ${totalTokens} tokens (prompt: ${totalPromptTokens}, completion: ${totalCompletionTokens})`
    );

    this.history.push({
      userMessage,
      assistantMessage: fullResponse,
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
