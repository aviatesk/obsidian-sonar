import { MarkdownView } from 'obsidian';

interface DocumentContext {
  lineStart: number;
  lineEnd: number;
  mode: 'source' | 'preview';
  hasSelection: boolean;
}

function getEditModeContext(
  view: MarkdownView,
  preferCursor: boolean = false
): DocumentContext | null {
  if (!view.editor) return null;

  const selection = view.editor.getSelection();
  if (selection) {
    const from = view.editor.getCursor('from');
    const to = view.editor.getCursor('to');
    return {
      lineStart: from.line,
      lineEnd: to.line,
      mode: 'source',
      hasSelection: true,
    };
  }

  if (preferCursor) {
    const cursor = view.editor.getCursor();
    return {
      lineStart: cursor.line,
      lineEnd: cursor.line,
      mode: 'source',
      hasSelection: false,
    };
  }

  const scrollInfo = view.editor.getScrollInfo();
  const scrollerEl = view.containerEl.querySelector(
    '.cm-scroller'
  ) as HTMLElement;
  const contentEl = scrollerEl?.querySelector('.cm-content') as HTMLElement;

  if (scrollerEl && contentEl && scrollInfo) {
    const viewportHeight = scrollerEl.clientHeight;
    const scrollTop = scrollInfo.top;
    const totalContentHeight = contentEl.scrollHeight;

    const totalLines = view.editor.lastLine() + 1;
    const avgLineHeight = totalContentHeight / totalLines;

    const visibleStartLine = Math.floor(scrollTop / avgLineHeight);
    const visibleEndLine = Math.min(
      Math.ceil((scrollTop + viewportHeight) / avgLineHeight),
      view.editor.lastLine()
    );

    return {
      lineStart: Math.max(0, visibleStartLine),
      lineEnd: visibleEndLine,
      mode: 'source',
      hasSelection: false,
    };
  }

  const cursor = view.editor.getCursor();
  return {
    lineStart: cursor.line,
    lineEnd: cursor.line,
    mode: 'source',
    hasSelection: false,
  };
}

function getFullDocumentContextFallback(
  view: MarkdownView
): DocumentContext | null {
  if (!view.editor) return null;
  const lastLine = view.editor.lastLine();
  return {
    lineStart: 0,
    lineEnd: lastLine,
    mode: 'preview',
    hasSelection: false,
  };
}

function getReadingModeContext(view: MarkdownView): DocumentContext | null {
  const previewEl = view.containerEl.querySelector(
    '.markdown-preview-view'
  ) as HTMLElement;
  if (!previewEl) return null;

  const visibleBlocks = Array.from(
    previewEl.querySelectorAll('[data-line-start][data-line-end]')
  ).filter(el => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    const previewRect = previewEl.getBoundingClientRect();
    return rect.top < previewRect.bottom && rect.bottom > previewRect.top;
  });

  if (visibleBlocks.length === 0) {
    return getFullDocumentContextFallback(view);
  }

  const lineRanges = visibleBlocks
    .map(el => {
      const htmlEl = el as HTMLElement;
      return {
        start: Number(htmlEl.dataset.lineStart),
        end: Number(htmlEl.dataset.lineEnd),
      };
    })
    .filter(range => !isNaN(range.start) && !isNaN(range.end));

  if (lineRanges.length === 0) {
    return getFullDocumentContextFallback(view);
  }

  return {
    lineStart: Math.min(...lineRanges.map(r => r.start)),
    lineEnd: Math.max(...lineRanges.map(r => r.end)),
    mode: 'preview',
    hasSelection: false,
  };
}

export function getCurrentContext(
  view: MarkdownView,
  preferCursor: boolean = false
): DocumentContext | null {
  const mode = view.getMode();
  return mode === 'source'
    ? getEditModeContext(view, preferCursor)
    : getReadingModeContext(view);
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
