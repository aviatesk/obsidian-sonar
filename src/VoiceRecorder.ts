import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type RecordingState = 'idle' | 'recording' | 'processing';

export interface VoiceRecorderCallbacks {
  onStateChange: (state: RecordingState) => void;
  onError: (error: Error) => void;
}

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private state: RecordingState = 'idle';
  private callbacks: VoiceRecorderCallbacks;

  constructor(callbacks: VoiceRecorderCallbacks) {
    this.callbacks = callbacks;
  }

  getState(): RecordingState {
    return this.state;
  }

  private setState(state: RecordingState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  async startRecording(): Promise<void> {
    if (this.state !== 'idle') {
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.callbacks.onError(
        new Error(
          `Microphone access denied: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }

    this.audioChunks = [];

    // Prefer webm with opus codec, fallback to whatever is available
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

    this.mediaRecorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined
    );

    this.mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onerror = event => {
      const error = (event as Event & { error?: DOMException }).error;
      this.callbacks.onError(
        new Error(`Recording error: ${error?.message ?? 'Unknown error'}`)
      );
      this.cleanup();
    };

    this.mediaRecorder.start();
    this.setState('recording');
  }

  async stopRecording(): Promise<string | null> {
    if (this.state !== 'recording' || !this.mediaRecorder) {
      return null;
    }

    this.setState('processing');

    return new Promise(resolve => {
      if (!this.mediaRecorder) {
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const tempPath = await this.saveToTempFile(audioBlob);
        this.cleanup();
        resolve(tempPath);
      };

      this.mediaRecorder.stop();
    });
  }

  cancelRecording(): void {
    this.cleanup();
  }

  private async saveToTempFile(blob: Blob): Promise<string> {
    const tempDir = os.tmpdir();
    const tempPath = path.join(
      tempDir,
      `sonar-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`
    );

    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fsp.writeFile(tempPath, buffer);

    return tempPath;
  }

  private cleanup(): void {
    if (this.mediaRecorder) {
      // Stop all tracks to release the microphone
      const tracks = this.mediaRecorder.stream.getTracks();
      tracks.forEach(track => track.stop());
      this.mediaRecorder = null;
    }
    this.audioChunks = [];
    this.setState('idle');
  }
}

export function deleteTempFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
