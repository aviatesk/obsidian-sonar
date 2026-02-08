import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolveServerPath } from './llamaCppUtils';
import { formatDuration } from './utils';

interface AudioLogger {
  log(msg: string, ...data: unknown[]): void;
  warn?(msg: string, ...data: unknown[]): void;
  error?(msg: string, ...data: unknown[]): void;
}

const LOG_PREFIX = '[Sonar.Audio]';

export interface AudioTranscriptionConfig {
  whisperCliPath: string;
  whisperModelPath: string;
  ffmpegPath: string;
  language: string;
}

function expandHomePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac'] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export function isAudioExtension(ext: string): ext is AudioExtension {
  return AUDIO_EXTENSIONS.includes(ext as AudioExtension);
}

export function getAudioExtensions(): readonly string[] {
  return AUDIO_EXTENSIONS;
}

interface TranscribeOptions {
  config: AudioTranscriptionConfig;
  logger?: AudioLogger;
}

export interface AudioSegment {
  startTime: number; // seconds
  endTime: number; // seconds
  text: string;
  startOffset: number; // char offset in concatenated full text
}

export interface TranscribeResult {
  text: string;
  segments: AudioSegment[];
}

async function getMetalResourcePath(): Promise<string | undefined> {
  return new Promise(resolve => {
    const brew = spawn('brew', ['--prefix', 'whisper-cpp']);
    let output = '';

    brew.stdout?.on('data', data => {
      output += data.toString();
    });

    brew.on('close', code => {
      if (code === 0 && output.trim()) {
        resolve(path.join(output.trim(), 'share/whisper-cpp'));
      } else {
        resolve(undefined);
      }
    });

    brew.on('error', () => {
      resolve(undefined);
    });
  });
}

async function convertToWav(
  inputPath: string,
  outputPath: string,
  ffmpegPath: string,
  logger?: AudioLogger
): Promise<void> {
  const resolvedFfmpeg = await resolveServerPath(ffmpegPath);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const args = [
      '-i',
      inputPath,
      '-ar',
      '16000', // 16kHz sample rate
      '-ac',
      '1', // mono
      '-c:a',
      'pcm_s16le', // 16-bit PCM
      '-y', // overwrite output
      outputPath,
    ];

    logger?.log(
      `${LOG_PREFIX} Converting ${path.basename(inputPath)} to WAV...`
    );

    const ffmpeg = spawn(resolvedFfmpeg, args, { stdio: 'pipe' });

    let stderr = '';
    ffmpeg.stderr?.on('data', data => {
      stderr += data.toString();
    });

    ffmpeg.on('error', error => {
      if ('code' in error && error.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found. Please install ffmpeg: brew install ffmpeg`
          )
        );
      } else {
        reject(new Error(`Failed to start ffmpeg: ${error.message}`));
      }
    });

    ffmpeg.on('close', code => {
      if (code === 0) {
        const duration = formatDuration(Date.now() - startTime);
        logger?.log(`${LOG_PREFIX} Converted to WAV in ${duration}`);
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with code ${code}: ${stderr}`));
      }
    });
  });
}

function parseTimestamp(ts: string): number {
  const [h, m, rest] = ts.split(':');
  const [s, ms] = rest.split('.');
  return (
    parseInt(h, 10) * 3600 +
    parseInt(m, 10) * 60 +
    parseInt(s, 10) +
    parseInt(ms, 10) / 1000
  );
}

const WHISPER_LINE_RE =
  /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)/;

export function parseWhisperOutput(stdout: string): AudioSegment[] {
  const segments: AudioSegment[] = [];
  let currentOffset = 0;

  for (const line of stdout.split('\n')) {
    const match = WHISPER_LINE_RE.exec(line);
    if (!match) continue;

    const text = match[3].trim();
    if (text.length === 0) continue;

    segments.push({
      startTime: parseTimestamp(match[1]),
      endTime: parseTimestamp(match[2]),
      text,
      startOffset: currentOffset,
    });

    // +1 for the newline joining segments in the full text
    currentOffset += text.length + 1;
  }

  return segments;
}

export function findSegmentForOffset(
  segments: AudioSegment[],
  offset: number
): number | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (offset >= segments[i].startOffset) {
      return segments[i].startTime;
    }
  }
  return undefined;
}

async function runWhisper(
  wavPath: string,
  options: TranscribeOptions
): Promise<TranscribeResult> {
  const { config, logger } = options;
  const resolvedWhisper = await resolveServerPath(config.whisperCliPath);
  const resolvedModelPath = expandHomePath(config.whisperModelPath);
  const metalPath = await getMetalResourcePath();
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // Don't use -nt (no timestamps) to get segment-based output with timestamps
    // We'll strip timestamps later but keep segment breaks as newlines
    const args = [
      '-l',
      config.language,
      '-m',
      resolvedModelPath,
      '-f',
      wavPath,
    ];

    logger?.log(`${LOG_PREFIX} Transcribing...`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (metalPath) {
      env.GGML_METAL_PATH_RESOURCES = metalPath;
    }

    const whisper = spawn(resolvedWhisper, args, { stdio: 'pipe', env });

    let stdout = '';
    let stderr = '';

    whisper.stdout?.on('data', data => {
      stdout += data.toString();
    });

    whisper.stderr?.on('data', data => {
      stderr += data.toString();
    });

    whisper.on('error', error => {
      if ('code' in error && error.code === 'ENOENT') {
        reject(
          new Error(
            `whisper-cli not found. Please install whisper-cpp: brew install whisper-cpp`
          )
        );
      } else {
        reject(new Error(`Failed to start whisper-cli: ${error.message}`));
      }
    });

    whisper.on('close', code => {
      if (code === 0) {
        const segments = parseWhisperOutput(stdout);
        const text = segments.map(s => s.text).join('\n');
        const duration = formatDuration(Date.now() - startTime);
        logger?.log(
          `${LOG_PREFIX} Transcribed ${text.length} characters (${segments.length} segments) in ${duration}`
        );
        resolve({ text, segments });
      } else {
        reject(new Error(`whisper-cli failed with code ${code}: ${stderr}`));
      }
    });
  });
}

export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions
): Promise<TranscribeResult> {
  const { config, logger } = options;

  const tempDir = os.tmpdir();
  const tempWavPath = path.join(
    tempDir,
    `sonar-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );

  try {
    await convertToWav(audioPath, tempWavPath, config.ffmpegPath, logger);
    return await runWhisper(tempWavPath, options);
  } finally {
    if (fs.existsSync(tempWavPath)) {
      fs.unlinkSync(tempWavPath);
    }
  }
}
