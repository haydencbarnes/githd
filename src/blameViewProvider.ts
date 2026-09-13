import * as vs from 'vscode';

import { Model } from './model';
import { GitService, GitBlameItem } from './gitService';
import { Tracer } from './tracer';
import { debounce, getPullRequests, isEmptyHash } from './utils';

const NotCommitted = `Not committed yet`;
const BlameDocumentSelector: vs.DocumentSelector = [{ scheme: 'file' }, { scheme: 'git' }];

class BlameViewStatProvider implements vs.Disposable, vs.HoverProvider {
  private _disposables: vs.Disposable[] = [];
  constructor(private _owner: BlameViewProvider) {
    this._disposables.push(vs.languages.registerHoverProvider(BlameDocumentSelector, this));
  }

  dispose(): void {
    vs.Disposable.from(...this._disposables).dispose();
  }

  provideHover(document: vs.TextDocument, position: vs.Position): vs.ProviderResult<vs.Hover> {
    if (!this._owner.shouldShowHover(document, position)) {
      return;
    }
    let markdown = new vs.MarkdownString(
      `*<span style="color:var(--vscode-githd-infoView-content);">Committed Files</span>*\r\n>\r\n`
    );
    markdown.appendCodeblock(this._owner.blame?.stat ?? '', 'typescript');
    markdown.appendMarkdown('>');
    markdown.isTrusted = true;
    return new vs.Hover(markdown);
  }
}

class BlameViewInfoProvider implements vs.Disposable, vs.HoverProvider {
  private _disposables: vs.Disposable[] = [];
  constructor(private _owner: BlameViewProvider, private _gitService: GitService) {
    this._disposables.push(vs.languages.registerHoverProvider(BlameDocumentSelector, this));
  }

  dispose(): void {
    vs.Disposable.from(...this._disposables).dispose();
  }

  provideHover(document: vs.TextDocument, position: vs.Position): vs.ProviderResult<vs.Hover> {
    if (!this._owner.shouldShowHover(document, position)) {
      return;
    }

    const blame = this._owner.blame as GitBlameItem; // shouldShowHover will be false if _blame is undefined
    const source = this._gitService.getFileRevision(blame.file);
    if (!source) {
      return;
    }
    return new Promise(async resolve => {
      const repo = await this._gitService.getGitRepo(source.file.fsPath);
      const ref: string = blame.hash;
      let args: string = encodeURIComponent(JSON.stringify([repo, ref, source.file]));
      const commit: string = `*[${ref}](command:githd.openCommit?${args} "Click to see commit details")*`;
      args = encodeURIComponent(JSON.stringify([blame.file]));
      const file: string = `[*file*](command:githd.viewFileHistory?${args} "Click to see current file history")`;
      args = encodeURIComponent(JSON.stringify([blame.file, blame.line]));
      const line: string = `[*line*](command:githd.viewLineHistory?${args} "Click to see current line history")`;
      let subject: string = '';
      let lastPREnd = 0;

      getPullRequests(blame.subject ?? '').forEach(([pr, start]) => {
        subject += blame.subject?.substring(lastPREnd, start) + `[*${pr}*](${repo?.remoteUrl}/pull/${pr.substring(1)})`;
        lastPREnd = start + pr.length;
      });

      subject += blame.subject?.substring(lastPREnd);
      const email = blame.email?.replace('@', '\\@');

      Tracer.verbose(`Blame view: ${commit}`);
      const content: string = `
${commit}
*</span><span style="color:var(--vscode-githd-historyView-author);">${blame.author}</span>*
*<span style="color:var(--vscode-githd-historyView-email);">${email}</span>*
*(${blame.date})*
&ensp;
*(<span style="color:var(--vscode-githd-historyView-title);">history</span>: ${file} || ${line})*

### ${subject}

${blame.body}
>`;

      let markdown = new vs.MarkdownString(content);
      markdown.isTrusted = true;
      return resolve(new vs.Hover(markdown));
    });
  }
}

export class BlameViewProvider {
  private _blame: GitBlameItem | undefined;
  private _updateVersion = 0;
  private _infoProvider: BlameViewInfoProvider;
  private _statProvider: BlameViewStatProvider;
  private _debouncedUpdate: (editor: vs.TextEditor) => void;
  private _blameViewMode: 'disabled' | 'blame' | 'detail' = 'disabled';
  private _decoration = vs.window.createTextEditorDecorationType({
    after: {
      color: new vs.ThemeColor('githd.blameView.info'),
      fontStyle: 'italic'
    }
  });

  constructor(
    context: vs.ExtensionContext,
    model: Model,
    private _gitService: GitService
  ) {
    this._blameViewMode = model.configuration.blameViewMode;
    this._statProvider = new BlameViewStatProvider(this);
    this._infoProvider = new BlameViewInfoProvider(this, _gitService);
    this._debouncedUpdate = debounce((editor: vs.TextEditor) => this._update(editor), 250);
    context.subscriptions.push(
      this._infoProvider,
      this._statProvider,
      this._decoration
    );
    vs.window.onDidChangeTextEditorSelection(
      e => {
        this._onDidChangeSelection(e.textEditor);
      },
      null,
      context.subscriptions
    );

    vs.window.onDidChangeActiveTextEditor(
      editor => {
        if (editor) {
          this._onDidChangeActiveTextEditor(editor);
        }
      },
      null,
      context.subscriptions
    );

    vs.workspace.onDidChangeTextDocument(
      e => {
        this._onDidChangeTextDocument(e.document);
      },
      null,
      context.subscriptions
    );

    model.onDidChangeConfiguration(
      config => {
        this._blameViewMode = config.blameViewMode;
      },
      null,
      context.subscriptions
    );
  }

  private get _enabled(): boolean {
    return this._blameViewMode !== 'disabled';
  }

  get blame(): GitBlameItem | undefined {
    return this._blame;
  }

  shouldShowHover(doc: vs.TextDocument, pos: vs.Position): boolean {
    if (
      this._blameViewMode === 'disabled' ||
      isEmptyHash(this._blame?.hash) ||
      doc.isDirty ||
      pos.line != this._blame?.line ||
      pos.character < doc.lineAt(this._blame.line).range.end.character ||
      doc.uri !== this._blame?.file
    ) {
      return false;
    }
    return this._blameViewMode === 'detail';
  }

  private async _onDidChangeSelection(editor: vs.TextEditor) {
    if (!editor || editor !== vs.window.activeTextEditor) {
      Tracer.info('_onDidChangeSelection with inactive or missing editor');
      return;
    }
    const file = editor.document.uri;
    if (!this._enabled || !vs.languages.match(BlameDocumentSelector, editor.document) || editor.document.isDirty) {
      return;
    }
    Tracer.verbose('Blame view: onDidChangeSelection');

    const line = editor.selection.active.line;
    if (!this._blame || line != this._blame.line || file !== this._blame.file) {
      this._clear(editor);
      this._debouncedUpdate(editor);
    }
  }

  private async _onDidChangeActiveTextEditor(editor: vs.TextEditor) {
    if (!editor) {
      Tracer.info('_onDidChangeActiveTextEditor with null or undefined editor');
      return;
    }
    if (!this._enabled || !vs.languages.match(BlameDocumentSelector, editor.document) || editor.document.isDirty) {
      return;
    }
    Tracer.verbose('Blame view: onDidChangeActiveTextEditor');
    this._clear(editor);
    this._update(editor);
  }

  private async _onDidChangeTextDocument(doc: vs.TextDocument) {
    const editor: vs.TextEditor | undefined = vs.window.activeTextEditor;
    if (!this._enabled || !vs.languages.match(BlameDocumentSelector, doc) || editor?.document !== doc) {
      return;
    }

    Tracer.verbose(`Blame view: onDidChange.TextDocument. isDirty ${doc.isDirty}`);

    this._clear(editor);
    if (!doc.isDirty) {
      this._update(editor);
    }
  }

  // The blame decoration is only shown for the active, saved editor while the view is enabled.
  private _canUpdate(editor: vs.TextEditor): boolean {
    return editor === vs.window.activeTextEditor && !editor.document.isDirty && this._enabled;
  }

  private async _update(editor: vs.TextEditor): Promise<void> {
    if (!this._canUpdate(editor)) {
      return;
    }
    const file = editor.document.uri;
    const line = editor.selection.active.line;
    const documentVersion = editor.document.version;
    const updateVersion = ++this._updateVersion;
    Tracer.verbose(` Try to update blame. ${file.fsPath}: ${line}`);

    const blame = await this._gitService.getBlameItem(file, line);
    if (
      updateVersion !== this._updateVersion ||
      !this._canUpdate(editor) ||
      file !== editor.document.uri ||
      line !== editor.selection.active.line ||
      documentVersion !== editor.document.version
    ) {
      Tracer.info(`This update is outdated. ${file.fsPath}: ${line}, dirty ${editor.document.isDirty}`);
      return;
    }
    this._blame = blame;
    if (!blame) {
      return;
    }

    let contentText = '\u00a0\u00a0\u00a0\u00a0';
    if (isEmptyHash(blame.hash)) {
      contentText += NotCommitted;
    } else {
      contentText += `${blame.author} [${blame.relativeDate}]\u00a0\u2022\u00a0${blame.subject}`;
    }
    const options: vs.DecorationOptions = {
      range: new vs.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
      renderOptions: { after: { contentText } }
    };
    editor.setDecorations(this._decoration, [options]);
  }

  private _clear(editor: vs.TextEditor): void {
    this._updateVersion++;
    this._blame = undefined;
    editor.setDecorations(this._decoration, []);
  }
}
