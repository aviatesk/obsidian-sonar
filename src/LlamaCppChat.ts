import type { ChildProcess } from 'child_process';
import type { ConfigManager } from './ConfigManager';
import { WithLogging } from './WithLogging';
import {
  isModelCached,
  downloadModel,
  getModelCachePath,
  findAvailablePort,
  killServerProcess,
  startLlamaServer,
  waitForServerReady,
  llamaServerChatCompletion,
  type ChatMessage,
  type ChatCompletionOptions,
  type ChatCompletionResponse,
} from './llamaCppUtils';

export type { ChatMessage, ChatCompletionOptions, ChatCompletionResponse };

/**
 * Chat completion using llama.cpp server
 * Manages a llama.cpp server process for chat/LLM inference
 */
export class LlamaCppChat extends WithLogging {
  protected readonly componentName = 'LlamaCppChat';

  private serverProcess: ChildProcess | null = null;
  private port: number | null = null;
  private exitHandlerBound: (() => void) | null = null;
  private ready = false;

  constructor(
    private serverPath: string,
    private modelRepo: string,
    private modelFile: string,
    protected configManager: ConfigManager,
    private statusCallback: (status: string) => void,
    private showNotice?: (msg: string, duration?: number) => void
  ) {
    super();
  }

  private updateStatus(status: string): void {
    this.statusCallback(status);
  }

  async initialize(): Promise<void> {
    this.log(`Initializing with model: ${this.modelRepo}/${this.modelFile}`);
    this.updateStatus('Chat: Initializing...');

    if (!isModelCached(this.modelRepo, this.modelFile)) {
      this.log(`Model not found in cache, downloading...`);
      await downloadModel(this.modelRepo, this.modelFile, progress => {
        if (progress.status === 'progress') {
          const percent = progress.percent.toFixed(0);
          this.updateStatus(`Chat: Loading ${percent}%`);
        }
      });
      this.log(`Model downloaded`);
    } else {
      this.log(`Using cached model`);
    }

    this.port = await findAvailablePort();
    this.log(`Selected port: ${this.port}`);

    await this.startServer();
    await this.waitForReady();
    this.log(`Initialized on port ${this.port}`);
  }

  private get serverUrl(): string {
    if (!this.port) {
      throw new Error('Server port not initialized');
    }
    return `http://localhost:${this.port}`;
  }

  private async startServer(): Promise<void> {
    if (!this.port) {
      throw new Error('Port not selected');
    }

    const modelPath = getModelCachePath(this.modelRepo, this.modelFile);

    this.log(`Starting llama.cpp chat server (port: ${this.port})...`);

    const args = [
      '--model',
      modelPath,
      '--port',
      this.port.toString(),
      '--ctx-size',
      '32768',
      '--parallel',
      '1',
      '-kvu',
      '-lv',
      '0',
    ];

    const result = await startLlamaServer({
      serverPath: this.serverPath,
      args,
      logger: this.configManager.getLogger(),
      showNotice: this.showNotice,
      onExit: () => {
        this.ready = false;
      },
      serverType: 'llama.cpp chat server',
    });

    this.serverProcess = result.process;
    this.exitHandlerBound = result.exitHandler;
  }

  private async waitForReady(): Promise<void> {
    await waitForServerReady(this.serverUrl, this.configManager.getLogger());
    this.ready = true;
  }

  /**
   * Send a chat completion request
   * @param messages Array of chat messages (conversation history)
   * @param options Optional generation parameters
   * @returns Promise that resolves to the completion response
   */
  async chat(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): Promise<ChatCompletionResponse> {
    if (!this.ready || !this.port) {
      throw new Error('Chat server not initialized. Call initialize() first.');
    }

    const topK = this.configManager.get('chatTopK');
    const defaultOptions: ChatCompletionOptions = {
      temperature: this.configManager.get('chatTemperature'),
      topK: topK > 0 ? topK : undefined,
      topP: this.configManager.get('chatTopP'),
      presencePenalty: this.configManager.get('chatPresencePenalty'),
      cachePrompt: true,
    };

    const mergedOptions = { ...defaultOptions, ...options };

    return llamaServerChatCompletion(this.serverUrl, messages, mergedOptions);
  }

  isReady(): boolean {
    return this.ready;
  }

  async cleanup(): Promise<void> {
    this.log(`Cleaning up...`);

    if (this.exitHandlerBound) {
      process.off('exit', this.exitHandlerBound);
      process.off('SIGINT', this.exitHandlerBound);
      process.off('SIGTERM', this.exitHandlerBound);
      this.exitHandlerBound = null;
    }

    if (this.serverProcess) {
      this.log(`Stopping server on port ${this.port}`);
      await killServerProcess(this.serverProcess, this.configManager.logger);
      this.serverProcess = null;
    }

    this.port = null;
    this.ready = false;

    this.log(`Completed cleanup`);
  }
}
