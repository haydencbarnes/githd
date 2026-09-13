import * as path from 'path';
import * as vs from 'vscode';

import { GitService, GitRepo, GitRef, GitRefType, GitCommittedFile } from './gitService';
import { GitLineCounts } from './gitParser';
import { Resource } from './resource';
import { descriptionSeparator } from './utils';

interface BranchPickItem extends vs.QuickPickItem {
  ref: GitRef;
}

function formatCounts(insertions: number, deletions: number): string {
  return `+${insertions} -${deletions}`;
}

function formatLineCounts(counts: GitLineCounts): string {
  return counts.binary ? 'binary' : formatCounts(counts.insertions, counts.deletions);
}

function formatLineCountsMarkdown(counts: GitLineCounts): string {
  if (counts.binary) {
    return 'binary';
  }
  return (
    `<span style="color:var(--vscode-terminal-ansiGreen);">+${counts.insertions}</span> ` +
    `<span style="color:var(--vscode-terminal-ansiRed);">-${counts.deletions}</span>`
  );
}

class CompareFileItem extends vs.TreeItem {
  private readonly _description: string;

  constructor(
    readonly file: GitCommittedFile,
    repo: GitRepo,
    base: GitRef,
    compare: GitRef
  ) {
    super(path.basename(file.gitRelativePath));
    const directory = path.dirname(file.gitRelativePath);
    this._description = directory === '.' ? file.status : `${file.status} | ${directory}`;
    const icon =
      file.status === 'A'
        ? 'diff-added'
        : file.status === 'D'
          ? 'diff-removed'
          : file.status === 'R'
            ? 'diff-renamed'
            : 'diff-modified';
    this.iconPath = new vs.ThemeIcon(icon, Resource.getGitStatusColor(file.status));
    this.command = {
      title: 'Open branch diff',
      command: 'githd.openCommittedFile',
      arguments: [file, { repo, leftRef: base.commit, rightRef: compare.commit }, `${base.name} .. ${compare.name}`]
    };
    this.setLineCounts(undefined);
  }

  setLineCounts(counts: GitLineCounts | undefined): void {
    this.description = counts ? this._description + descriptionSeparator + formatLineCounts(counts) : this._description;
    const tooltip = new vs.MarkdownString();
    // Trusted so the colored spans render; no commands are enabled. The path is escaped by appendText.
    tooltip.isTrusted = { enabledCommands: [] };
    tooltip.appendText(
      this.file.gitRelativeOldPath === this.file.gitRelativePath
        ? this.file.gitRelativePath
        : `${this.file.gitRelativeOldPath} -> ${this.file.gitRelativePath}`
    );
    if (counts) {
      tooltip.appendMarkdown(`\n\n${formatLineCountsMarkdown(counts)}`);
    }
    this.tooltip = tooltip;
  }
}

export class CompareViewProvider implements vs.TreeDataProvider<vs.TreeItem> {
  private readonly _onDidChange = new vs.EventEmitter<vs.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private readonly _view: vs.TreeView<vs.TreeItem>;
  private _repo: GitRepo | undefined;
  private _base: GitRef | undefined;
  private _compare: GitRef | undefined;
  private _files: CompareFileItem[] = [];
  private _request = 0;

  constructor(
    context: vs.ExtensionContext,
    private _gitService: GitService
  ) {
    this._view = vs.window.createTreeView('githd.compare', { treeDataProvider: this });
    context.subscriptions.push(
      this._view,
      this._onDidChange,
      vs.commands.registerCommand('githd.selectCompareRepository', () => this._selectRepository()),
      vs.commands.registerCommand('githd.selectCompareBranch', (side: 'base' | 'compare') => this._selectBranch(side)),
      vs.commands.registerCommand('githd.refreshCompare', () => this._refresh()),
      vs.commands.registerCommand('githd.swapCompareBranches', () => {
        [this._base, this._compare] = [this._compare, this._base];
        return this._refresh();
      }),
      this._gitService.onDidChangeGitRepositories(repos => {
        if (!this._repo || !repos.some(repo => repo.root === this._repo?.root)) {
          this._setRepository(repos[0]);
        }
      }),
      this._view.onDidChangeVisibility(event => {
        if (event.visible) {
          this._refresh();
        }
      })
    );
    const repos = this._gitService.getGitRepos();
    this._setRepository(repos.find(repo => repo.root === this._gitService.currentGitRepo?.root) ?? repos[0]);
  }

  getTreeItem(item: vs.TreeItem): vs.TreeItem {
    return item;
  }

  getChildren(item?: vs.TreeItem): vs.TreeItem[] {
    if (item) {
      return [];
    }

    const repository = new vs.TreeItem('Repository');
    repository.description = this._repo ? path.basename(this._repo.root) : 'Select repository...';
    repository.tooltip = this._repo?.root ?? 'Select repository';
    repository.iconPath = new vs.ThemeIcon('repo');
    repository.command = { title: 'Select repository', command: 'githd.selectCompareRepository' };
    return [repository, this._branchItem('base'), this._branchItem('compare'), ...this._files];
  }

  private _branchItem(side: 'base' | 'compare'): vs.TreeItem {
    const branch = side === 'base' ? this._base : this._compare;
    const item = new vs.TreeItem(side === 'base' ? 'Base' : 'Compare');
    item.description = branch?.name ?? 'Select branch...';
    item.tooltip = branch ? `${branch.name} (${branch.commit})` : `Select ${side} branch`;
    item.iconPath = new vs.ThemeIcon('git-branch');
    item.command = {
      title: `Select ${side} branch`,
      command: 'githd.selectCompareBranch',
      arguments: [side]
    };
    return item;
  }

  private _setRepository(repo: GitRepo | undefined): void {
    this._repo = repo;
    this._base = undefined;
    this._compare = undefined;
    this._refresh();
  }

  private async _selectRepository(): Promise<void> {
    const repos = this._gitService.getGitRepos();
    const selected = await vs.window.showQuickPick(
      repos.map(repo => ({ label: path.basename(repo.root), description: repo.root, repo })),
      { title: 'Compare: Repository', matchOnDescription: true }
    );
    if (
      selected &&
      this._gitService.getGitRepos().some(repo => repo.root === selected.repo.root) &&
      selected.repo.root !== this._repo?.root
    ) {
      this._setRepository(selected.repo);
    }
  }

  private async _getBranches(repo: GitRepo): Promise<GitRef[]> {
    return (await this._gitService.getRefs(repo, true)).filter(
      ref =>
        ref.name &&
        (ref.type === GitRefType.Head || (ref.type === GitRefType.RemoteHead && !ref.name.endsWith('/HEAD')))
    );
  }

  private _isCurrentRepo(repo: GitRepo): boolean {
    return this._repo?.root === repo.root;
  }

  private async _selectBranch(side: 'base' | 'compare'): Promise<void> {
    const repo = this._repo;
    if (!repo) {
      await this._selectRepository();
      return;
    }
    try {
      const selected = await this._pickBranch(repo, side);
      if (!selected || !this._isCurrentRepo(repo)) {
        return;
      }
      if (side === 'base') {
        this._base = selected;
      } else {
        this._compare = selected;
      }
      await this._refresh();
    } catch (error) {
      if (this._isCurrentRepo(repo)) {
        vs.window.showErrorMessage(`GitHD: Unable to load branches. ${String(error).trim()}`);
      }
    }
  }

  // Shows the branch picker for one side of the comparison. Resolves to undefined when nothing
  // was picked or the repository changed while the branches were loading.
  private async _pickBranch(repo: GitRepo, side: 'base' | 'compare'): Promise<GitRef | undefined> {
    const refs = await this._getBranches(repo);
    if (!this._isCurrentRepo(repo)) {
      return undefined;
    }
    if (!refs.length) {
      this._view.message = 'No branches available.';
      return undefined;
    }
    const items: BranchPickItem[] = refs.map(ref => ({
      label: ref.name!,
      description: `${ref.type === GitRefType.RemoteHead ? 'Remote' : 'Local'} branch at ${ref.commit}`,
      ref
    }));
    const selected = await vs.window.showQuickPick(items, {
      title: side === 'base' ? 'Compare: Base Branch (Left)' : 'Compare: Branch (Right)',
      matchOnDescription: true
    });
    return selected?.ref;
  }

  private async _refresh(): Promise<void> {
    const request = ++this._request;
    const repo = this._repo;
    this._files = [];
    this._view.description = undefined;
    this._view.message = repo ? 'Loading branches...' : 'No Git repository selected.';
    this._onDidChange.fire(undefined);
    if (!repo) {
      return;
    }
    try {
      await this._loadComparison(repo, request);
    } catch (error) {
      if (request === this._request) {
        this._view.message = `Unable to compare branches. ${String(error).trim()}`;
      }
    } finally {
      if (request === this._request) {
        this._onDidChange.fire(undefined);
      }
    }
  }

  // Re-resolves the selected branches against the repository and lists the files that differ
  // between them. Bails out silently whenever a newer request has superseded this one.
  private async _loadComparison(repo: GitRepo, request: number): Promise<void> {
    const refs = await this._getBranches(repo);
    if (request !== this._request) {
      return;
    }
    this._base = refs.find(ref => ref.name === this._base?.name && ref.type === this._base?.type);
    this._compare = refs.find(ref => ref.name === this._compare?.name && ref.type === this._compare?.type);
    const base = this._base;
    const compare = this._compare;
    if (!base || !compare) {
      this._view.message = refs.length ? 'Two branches required.' : 'No branches available.';
      return;
    }
    this._view.message = 'Loading comparison...';
    // Line counts require git to diff every file, so they are requested alongside the file list
    // and filled in once the list is shown. A failure only leaves the counts out (getLineCounts
    // does not throw), while a failure to list the files is reported by _refresh.
    const lineCountsRequest = this._gitService.getLineCounts(repo, base.commit, compare.commit);
    const [, files] = await this._gitService.getCommittedFiles(repo, compare.commit, base.commit, false, true);
    if (request !== this._request) {
      return;
    }
    this._files = files
      .sort((left, right) => left.gitRelativePath.localeCompare(right.gitRelativePath))
      .map(file => new CompareFileItem(file, repo, base, compare));
    this._view.description = `${files.length} changed file${files.length === 1 ? '' : 's'}`;
    this._view.message = files.length ? undefined : 'No differences between these branches.';
    this._onDidChange.fire(undefined);

    const lineCounts = await lineCountsRequest;
    if (request === this._request) {
      this._applyLineCounts(lineCounts);
    }
  }

  // Fills in the per-file line counts and appends their totals to the view description.
  private _applyLineCounts(lineCounts: Map<string, GitLineCounts>): void {
    if (!lineCounts.size) {
      return;
    }
    let insertions = 0;
    let deletions = 0;
    lineCounts.forEach(counts => {
      insertions += counts.insertions;
      deletions += counts.deletions;
    });
    this._files.forEach(item => item.setLineCounts(lineCounts.get(item.file.gitRelativePath)));
    this._view.description += descriptionSeparator + formatCounts(insertions, deletions);
  }
}
