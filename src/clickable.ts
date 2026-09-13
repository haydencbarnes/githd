import * as vs from 'vscode';

import { Tracer } from './tracer';
import { getTextEditors } from './utils';

export interface Clickable {
  readonly range: vs.Range;
  readonly callback: () => any;
  readonly clickedDecorationType?: vs.TextEditorDecorationType;
  getHoverMessage?: () => vs.MarkdownString | Promise<vs.MarkdownString>;
}

export class ClickableProvider implements vs.HoverProvider {
  private _clickables: Clickable[] = [];
  // the clickables by the lines they span, to find the one at a position without scanning them all
  private _clickablesByLine = new Map<number, Clickable[]>();
  // the ranges of all the clickables, rebuilt on demand
  private _ranges: vs.Range[] | undefined;
  private _disposables: vs.Disposable[] = [];
  private _lastClickedItems: Clickable[] = [];

  private _decoration = vs.window.createTextEditorDecorationType({
    cursor: 'pointer',
    textDecoration: 'underline'
  });

  constructor(private _scheme: string) {
    this._disposables.push(vs.languages.registerHoverProvider({ scheme: _scheme }, this));
    this._disposables.push(this._decoration);

    vs.window.onDidChangeTextEditorSelection(
      event => {
        let editor = event.textEditor;
        if (editor && editor.document.uri.scheme === _scheme) {
          if (event.kind === vs.TextEditorSelectionChangeKind.Mouse) {
            const clickable = this._findClickable(event.selections[0].anchor);
            if (clickable) {
              this._onClicked(clickable, editor);
            }
          }
        }
      },
      null,
      this._disposables
    );

    vs.window.onDidChangeActiveTextEditor(
      editor => {
        if (editor && editor.document.uri.scheme === _scheme) {
          this._setDecorations(editor);
        }
      },
      null,
      this._disposables
    );

    vs.window.onDidChangeVisibleTextEditors(
      editors => {
        editors.forEach(editor => {
          if (editor && editor.document.uri.scheme === _scheme) {
            this._setDecorations(editor);
          }
        });
      },
      null,
      this._disposables
    );

    vs.workspace.onDidChangeTextDocument(
      e => {
        if (e.document.uri.scheme === _scheme) {
          getTextEditors(_scheme).forEach(editor => this._setDecorations(editor));
        }
      },
      null,
      this._disposables
    );
  }

  async provideHover(document: vs.TextDocument, position: vs.Position): Promise<vs.Hover | undefined> {
    const clickable = this._findClickable(position);
    if (clickable && clickable.getHoverMessage) {
      const content = await clickable.getHoverMessage();
      return new vs.Hover(content);
    }
  }

  addClickable(clickable: Clickable): void {
    this._clickables.push(clickable);
    this._ranges = undefined;
    for (let line = clickable.range.start.line; line <= clickable.range.end.line; line++) {
      const clickables = this._clickablesByLine.get(line);
      if (clickables) {
        clickables.push(clickable);
      } else {
        this._clickablesByLine.set(line, [clickable]);
      }
    }
  }

  removeClickable(range: vs.Range): void {
    if (range) {
      const lines: Clickable[][] = [];
      for (let line = range.start.line; line <= range.end.line; line++) {
        const clickables = this._clickablesByLine.get(line);
        if (clickables) {
          lines.push(clickables);
        }
      }
      [this._clickables, this._lastClickedItems, ...lines].forEach(clickables => {
        const index: number = clickables.findIndex(e => {
          return e.range.isEqual(range);
        });
        if (index !== -1) {
          clickables.splice(index, 1);
        }
      });
      this._ranges = undefined;
    }
  }

  // the first clickable containing the position, in the order they were added
  private _findClickable(position: vs.Position): Clickable | undefined {
    return this._clickablesByLine.get(position.line)?.find(e => e.range.contains(position));
  }

  clear(): void {
    this._clickables = [];
    this._clickablesByLine.clear();
    this._ranges = undefined;
    getTextEditors(this._scheme).forEach(editor => {
      this._lastClickedItems.forEach(clickable => {
        if (clickable.clickedDecorationType) {
          editor.setDecorations(clickable.clickedDecorationType, []);
        }
      });
    });
    this._lastClickedItems = [];
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }

  private _onClicked(clickable: Clickable, editor: vs.TextEditor): void {
    if (clickable.clickedDecorationType) {
      editor.setDecorations(clickable.clickedDecorationType, [clickable.range]);
      const index: number = this._lastClickedItems.findIndex(e => {
        return e.clickedDecorationType === clickable.clickedDecorationType;
      });
      if (index !== -1) {
        this._lastClickedItems.splice(index, 1);
      }
      this._lastClickedItems.push(clickable);
    }
    clickable.callback();
  }

  private _setDecorations(editor?: vs.TextEditor): void {
    if (!editor || editor.document.uri.scheme !== this._scheme) {
      Tracer.warning(`Clickable: try to set decoration to wrong scheme: ${editor ? editor.document.uri.scheme : ''}`);
      return;
    }
    this._lastClickedItems.forEach(clickable => {
      if (clickable.clickedDecorationType) {
        editor.setDecorations(clickable.clickedDecorationType, [clickable.range]);
      }
    });
    if (!this._ranges) {
      this._ranges = this._clickables.map(clickable => clickable.range);
    }
    editor.setDecorations(this._decoration, this._ranges);
  }
}
