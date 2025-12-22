export function truncateQuery(query: string, maxLength: number = 30): string {
  const trimmed = query.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return `"${trimmed}"`;
  return `"${trimmed.slice(0, maxLength)}..."`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

/**
 * Check if an embedding contains NaN values
 */
export function hasNaNEmbedding(embedding: number[]): boolean {
  return embedding.some(x => Number.isNaN(x));
}

/**
 * Count NaN values in an embedding
 */
export function countNaNValues(embedding: number[]): number {
  return embedding.filter(x => Number.isNaN(x)).length;
}

export interface ProgressiveWaitOptions {
  checkReady: () => Promise<boolean>;
  onStillWaiting?: () => void;
  maxTimeMs?: number;
  delaySequence?: number[];
}

/**
 * Wait with progressive delays until a condition is met
 *
 * @param options - Wait options
 * @returns Promise that resolves when checkReady returns true
 * @throws Error if timeout is reached
 */
export async function progressiveWait(
  options: ProgressiveWaitOptions
): Promise<void> {
  const {
    checkReady,
    onStillWaiting,
    maxTimeMs = 600000, // 10 minutes
    delaySequence = [1000, 5000, 10000, 30000, 60000],
  } = options;

  let elapsedMs = 0;
  let attemptIndex = 0;

  while (elapsedMs < maxTimeMs) {
    if (await checkReady()) {
      return;
    }

    if (attemptIndex === 3) {
      onStillWaiting?.();
    }

    const delayIndex = Math.min(attemptIndex, delaySequence.length - 1);
    const delayMs = delaySequence[delayIndex];

    await new Promise(resolve => setTimeout(resolve, delayMs));
    elapsedMs += delayMs;
    attemptIndex++;
  }

  throw new Error(`Timeout after ${maxTimeMs / 1000}s`);
}
