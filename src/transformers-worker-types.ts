/**
 * Type definitions for Transformers.js Worker RPC communication
 * Shared between main thread (TransformersWorker.ts) and Worker (transformers-worker.entry.ts)
 */

// Define all RPC methods with their params and return types in one place
export interface RPCMethods {
  embeddings: {
    params: {
      texts: string[];
      modelId: string;
      device: 'webgpu' | 'wasm';
      dtype: 'q8' | 'q4' | 'fp16' | 'fp32';
    };
    returns: number[][];
  };
  countTokens: {
    params: {
      text: string;
      modelId: string;
    };
    returns: number;
  };
  getTokenIds: {
    params: {
      text: string;
      modelId: string;
    };
    returns: number[];
  };
}

// Auto-generate RPCRequest from RPCMethods
export type RPCRequest = {
  [M in keyof RPCMethods]: {
    id: string;
    method: M;
    params: RPCMethods[M]['params'];
  };
}[keyof RPCMethods];

// Auto-generate return type map from RPCMethods
export type RPCMethodReturnTypes = {
  [M in keyof RPCMethods]: RPCMethods[M]['returns'];
};

export interface RPCResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface ReadyMessage {
  __kind: 'ready';
  ts: number;
}

export interface InitMessage {
  __kind: 'init';
  logLevel: 'error' | 'warn' | 'log';
}

export interface UpdateLogLevelMessage {
  __kind: 'update-log-level';
  logLevel: 'error' | 'warn' | 'log';
}
