import { writable, derived, get, type Readable } from 'svelte/store';

export type ModelStatus = 'uninitialized' | 'initializing' | 'ready' | 'failed';

export interface StatusBarClickAction {
  action: () => void;
  actionName: string;
  confirmTitle: string;
  confirmMessage: string;
  confirmButton: string;
}

export interface SonarModelState {
  embedder: ModelStatus;
  reranker: ModelStatus;
  metadataStore: ModelStatus;
  bm25Store: ModelStatus;
  statusBarText: string;
  statusBarTooltip?: string;
  onStatusBarClick?: StatusBarClickAction;
}

const initialState: SonarModelState = {
  embedder: 'uninitialized',
  reranker: 'uninitialized',
  metadataStore: 'uninitialized',
  bm25Store: 'uninitialized',
  statusBarText: 'Initializing...',
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

    setMetadataStoreStatus(status: ModelStatus) {
      update(state => ({ ...state, metadataStore: status }));
    },

    setBm25StoreStatus(status: ModelStatus) {
      update(state => ({ ...state, bm25Store: status }));
    },

    setStatusBarText(text: string, tooltip?: string) {
      update(state => ({
        ...state,
        statusBarText: text,
        statusBarTooltip: tooltip,
      }));
    },

    setOnStatusBarClick(clickAction?: StatusBarClickAction) {
      update(state => ({ ...state, onStatusBarClick: clickAction }));
    },

    reset() {
      update(() => ({ ...initialState }));
    },
  };
}

export const sonarState = createSonarState();

export const isSearchReady: Readable<boolean> = derived(
  sonarState,
  $state =>
    $state.embedder === 'ready' &&
    $state.metadataStore === 'ready' &&
    $state.bm25Store === 'ready'
);

export const isRerankerReady: Readable<boolean> = derived(
  sonarState,
  $state => $state.reranker === 'ready'
);

export function getState(): SonarModelState {
  return get(sonarState);
}

export function checkSearchReady(state: SonarModelState): boolean {
  return (
    state.embedder === 'ready' &&
    state.metadataStore === 'ready' &&
    state.bm25Store === 'ready'
  );
}

export function checkHasFailure(state: SonarModelState): boolean {
  return (
    state.embedder === 'failed' ||
    state.metadataStore === 'failed' ||
    state.bm25Store === 'failed'
  );
}
