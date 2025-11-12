import { type LogLevel, LOG_LEVEL_ORDER } from './config';
import type { ConfigManager } from './ConfigManager';

export class Logger {
  constructor(private getLogLevel: () => LogLevel) {}

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[this.getLogLevel()];
  }

  verbose(msg: string, ...data: any[]): void {
    if (this.shouldLog('verbose')) {
      console.log(msg, ...data);
    }
  }

  log(msg: string, ...data: any[]): void {
    if (this.shouldLog('log')) {
      console.log(msg, ...data);
    }
  }

  warn(msg: string, ...data: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(msg, ...data);
    }
  }

  error(msg: string, ...data: any[]): void {
    if (this.shouldLog('error')) {
      console.error(msg, ...data);
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

  protected verbose(msg: string, ...data: any[]): void {
    this.configManager
      .getLogger()
      .verbose(`[Sonar.${this.componentName}] ${msg}`, ...data);
  }

  protected log(msg: string, ...data: any[]): void {
    this.configManager
      .getLogger()
      .log(`[Sonar.${this.componentName}] ${msg}`, ...data);
  }

  protected error(msg: string, ...data: any[]): void {
    this.configManager
      .getLogger()
      .error(`[Sonar.${this.componentName}] ${msg}`, ...data);
  }

  protected warn(msg: string, ...data: any[]): void {
    this.configManager
      .getLogger()
      .warn(`[Sonar.${this.componentName}] ${msg}`, ...data);
  }
}
