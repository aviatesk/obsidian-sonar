import { MarkdownView } from 'obsidian';

export interface DocumentContext {
  lineStart: number;
  lineEnd: number;
  mode: 'source' | 'preview';
  hasSelection: boolean;
}

export function getEditModeContext(view: MarkdownView): DocumentContext | null {
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

  const cursor = view.editor.getCursor();
  return {
    lineStart: cursor.line,
    lineEnd: cursor.line,
    mode: 'source',
    hasSelection: false,
  };
}

export function getReadingModeContext(
  view: MarkdownView
): DocumentContext | null {
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

  if (visibleBlocks.length === 0) return null;

  const lineRanges = visibleBlocks
    .map(el => {
      const htmlEl = el as HTMLElement;
      return {
        start: Number(htmlEl.dataset.lineStart),
        end: Number(htmlEl.dataset.lineEnd),
      };
    })
    .filter(range => !isNaN(range.start) && !isNaN(range.end));

  if (lineRanges.length === 0) return null;

  return {
    lineStart: Math.min(...lineRanges.map(r => r.start)),
    lineEnd: Math.max(...lineRanges.map(r => r.end)),
    mode: 'preview',
    hasSelection: false,
  };
}

export function getCurrentContext(view: MarkdownView): DocumentContext | null {
  const mode = view.getMode();
  return mode === 'source'
    ? getEditModeContext(view)
    : getReadingModeContext(view);
}
