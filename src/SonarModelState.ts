import { writable, derived, get, type Readable } from 'svelte/store';

export type ModelStatus = 'uninitialized' | 'initializing' | 'ready' | 'failed';

export interface SonarModelState {
  embedder: ModelStatus;
  reranker: ModelStatus;
  chatModel: ModelStatus;
}

const initialState: SonarModelState = {
  embedder: 'uninitialized',
  reranker: 'uninitialized',
  chatModel: 'uninitialized',
};

function createSonarState() {
  const { subscribe, update } = writable<SonarModelState>(initialState);

  return {
    subscribe,

    setEmbedderStatus(status: ModelStatus) {
      update(state => ({ ...state, embedder: status }));
    },

    setRerankerStatus(status: ModelStatus) {
      update(state => ({ ...state, reranker: status }));
    },

    setChatModelStatus(status: ModelStatus) {
      update(state => ({ ...state, chatModel: status }));
    },

    reset() {
      update(() => ({ ...initialState }));
    },
  };
}

export const sonarState = createSonarState();

export const isSearchReady: Readable<boolean> = derived(
  sonarState,
  $state => $state.embedder === 'ready'
);

export const hasInitializationFailed: Readable<boolean> = derived(
  sonarState,
  $state => $state.embedder === 'failed'
);

export const isRerankerReady: Readable<boolean> = derived(
  sonarState,
  $state => $state.reranker === 'ready'
);

export const isChatModelReady: Readable<boolean> = derived(
  sonarState,
  $state => $state.chatModel === 'ready'
);

export function getState(): SonarModelState {
  return get(sonarState);
}
