import * as vscode from 'vscode';
import { GitLogEntry } from './gitService';
import { Tracer } from './tracer';
import { Model } from './model';

export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'githd.stats';
  private _extensionUri: vscode.Uri;
  private _webviewUri: vscode.Uri;
  private _view: vscode.WebviewView | undefined;
  private _commits: { stats: string; date: number }[] = [];
  private _shadowArea: { start: number; end: number } | null = null;
  // the shadow area the chart currently shows, to skip posting it again
  private _postedShadowArea: { start: number; end: number } | null = null;
  // set when the shadow area changed while the view was hidden
  private _shadowAreaOutdated = false;
  private _dataBucketsCount: number;
  constructor(
    context: vscode.ExtensionContext,
    private _model: Model
  ) {
    this._extensionUri = context.extensionUri;
    this._webviewUri = vscode.Uri.joinPath(this._extensionUri, 'media');
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, this, {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      })
    );
    this._model.onDidChangeConfiguration(() => {
      const bucketsCount = this._model.configuration.dataBucketsCount;
      if (!!bucketsCount && this._dataBucketsCount !== bucketsCount) {
        this._dataBucketsCount = bucketsCount;
        this.update();
      }
    });
    this._dataBucketsCount = _model.configuration.dataBucketsCount ?? 91;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    Tracer.verbose('PanelViewProvider: resolveWebviewView');
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._webviewUri, vscode.Uri.joinPath(this._extensionUri, 'dist')]
    };
    webviewView.webview.html = this._getWebviewContent(webviewView.webview);

    // Wait a short time before updating to ensure the webview is fully loaded
    setTimeout(() => {
      this.update();
      this._postShadowArea();
    }, 500);

    // the shadow area follows the scrolling of the history view, which is skipped while the
    // chart is hidden: catch up when it shows again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this._shadowAreaOutdated) {
        this._postShadowArea();
      }
    });

    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'selectionMade':
          this.onSelectionMade(message.start, message.end);
          break;
      }
    });
  }

  private onSelectionMade(start: string, end: string) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    Tracer.verbose(`PanelViewProvider: selectionMade: ${startDate.toISOString()} - ${endDate.toISOString()}`);
    const context = this._model.historyViewContext;
    if (context) {
      context.startTime = startDate;
      context.endTime = endDate;
      this._model.setHistoryViewContext(context);
    }
  }

  update() {
    Tracer.verbose(`PanelViewProvider: update: commits ${this._commits.length} buckets ${this._dataBucketsCount}`);
    if (this._view) {
      // the chart is rebuilt with the data, its shadow area has to be set again
      this._postedShadowArea = null;
      this._view.webview.postMessage({
        type: 'updateChart',
        data: this._commits,
        bucketsCount: this._dataBucketsCount
      });
    }
  }

  addLogs(logs: GitLogEntry[]) {
    const commits = logs.filter(log => !!log.stat).map(log => ({ stats: log.stat ?? '', date: log.timestamp * 1000 }));
    this._commits.push(...commits);
  }

  clearLogs() {
    this._commits = [];
  }

  setShadowArea(start: number, end: number) {
    this._shadowArea = { start, end };
    this._postShadowArea();
  }

  // Posts the shadow area unless the chart already shows it or is hidden. Every post makes the
  // chart redraw, which is wasted while scrolling within the same commits or with a hidden chart.
  private _postShadowArea() {
    const area = this._shadowArea;
    if (!this._view || !area) {
      return;
    }
    if (!this._view.visible) {
      this._shadowAreaOutdated = true;
      return;
    }
    this._shadowAreaOutdated = false;
    if (this._postedShadowArea?.start === area.start && this._postedShadowArea?.end === area.end) {
      return;
    }
    Tracer.verbose(`PanelViewProvider: setShadowArea: ${area.start} - ${area.end}`);
    this._postedShadowArea = area;
    this._view.webview.postMessage({
      type: 'setShadowArea',
      start: area.start * 1000,
      end: area.end * 1000
    });
  }

  private _getWebviewContent(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._webviewUri, 'stats.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._webviewUri, 'style.css'));
    const chartjsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'chart.js'));

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <script src="${chartjsUri}"></script>
            </head>
            <body>
                <div id="chart-container">
                    <canvas id="chart"></canvas>
                </div>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
  }
}
