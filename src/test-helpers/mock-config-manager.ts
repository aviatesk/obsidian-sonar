import type { ConfigManager } from '../ConfigManager';
import { DEFAULT_SETTINGS } from '../config';

export function createMockConfigManager(): ConfigManager {
  const mockLogger = {
    log: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
    verbose: () => {},
  };
  return {
    logger: mockLogger,
    get: (key: string) =>
      (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key],
    getLogger: () => mockLogger,
  } as unknown as ConfigManager;
}
