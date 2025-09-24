export type LogLevel = 'error' | 'warn' | 'log';

export class Logger {
  constructor(private getLogLevel: () => LogLevel) {}

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['error', 'warn', 'log'];
    return levels.indexOf(level) <= levels.indexOf(this.getLogLevel());
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
