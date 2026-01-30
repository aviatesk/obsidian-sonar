import { writable, derived, get, type Readable } from 'svelte/store';

export type ModelStatus = 'uninitialized' | 'initializing' | 'ready' | 'failed';

export interface SonarModelState {
  embedder: ModelStatus;
  reranker: ModelStatus;
  searchReady: boolean;
}

const initialState: SonarModelState = {
  embedder: 'uninitialized',
  reranker: 'uninitialized',
  searchReady: false,
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

    setSearchReady(ready: boolean) {
      update(state => ({ ...state, searchReady: ready }));
    },

    reset() {
      update(() => ({ ...initialState }));
    },
  };
}

export const sonarState = createSonarState();

export const isSearchReady: Readable<boolean> = derived(
  sonarState,
  $state => $state.searchReady
);

export const hasInitializationFailed: Readable<boolean> = derived(
  sonarState,
  $state => $state.embedder === 'failed'
);

export const isRerankerReady: Readable<boolean> = derived(
  sonarState,
  $state => $state.reranker === 'ready'
);

export function getState(): SonarModelState {
  return get(sonarState);
}
