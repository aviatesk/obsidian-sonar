import { type LogLevel, LOG_LEVEL_ORDER } from './config';
import type { ConfigManager } from './ConfigManager';

export class Logger {
  constructor(private getLogLevel: () => LogLevel) {}

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[this.getLogLevel()];
  }

  verbose(msg: string): void {
    if (this.shouldLog('verbose')) {
      console.log(msg);
    }
  }

  log(msg: string): void {
    if (this.shouldLog('log')) {
      console.log(msg);
    }
  }

  warn(msg: string): void {
    if (this.shouldLog('warn')) {
      console.warn(msg);
    }
  }

  error(msg: string): void {
    if (this.shouldLog('error')) {
      console.error(msg);
    }
  }
}

/**
 * Base class providing logging functionality through ConfigManager
 * Automatically formats log messages with component name prefix
 */
export abstract class WithLogging {
  protected abstract readonly configManager: ConfigManager;
  protected abstract readonly componentName: string;

  protected verbose(msg: string): void {
    this.configManager
      .getLogger()
      .verbose(`[Sonar.${this.componentName}] ${msg}`);
  }

  protected log(msg: string): void {
    this.configManager.getLogger().log(`[Sonar.${this.componentName}] ${msg}`);
  }

  protected error(msg: string): void {
    this.configManager
      .getLogger()
      .error(`[Sonar.${this.componentName}] ${msg}`);
  }

  protected warn(msg: string): void {
    this.configManager.getLogger().warn(`[Sonar.${this.componentName}] ${msg}`);
  }
}
