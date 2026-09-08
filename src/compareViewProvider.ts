import * as path from 'path';
import * as vs from 'vscode';

import { GitService, GitRepo, GitRef, GitRefType } from './gitService';
import { Resource } from './resource';

interface BranchPickItem extends vs.QuickPickItem {
  ref: GitRef;
}

export class CompareViewProvider implements vs.TreeDataProvider<vs.TreeItem> {
  private readonly _onDidChange = new vs.EventEmitter<vs.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private readonly _view: vs.TreeView<vs.TreeItem>;
  private _repo: GitRepo | undefined;
  private _base: GitRef | undefined;
  private _compare: GitRef | undefined;
  private _files: vs.TreeItem[] = [];
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

  private async _selectBranch(side: 'base' | 'compare'): Promise<void> {
    const repo = this._repo;
    if (!repo) {
      await this._selectRepository();
      return;
    }
    try {
      const refs = await this._getBranches(repo);
      if (this._repo?.root !== repo.root) {
        return;
      }
      if (!refs.length) {
        this._view.message = 'No branches available.';
        return;
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
      if (!selected || this._repo?.root !== repo.root) {
        return;
      }
      if (side === 'base') {
        this._base = selected.ref;
      } else {
        this._compare = selected.ref;
      }
      await this._refresh();
    } catch (error) {
      if (this._repo?.root === repo.root) {
        vs.window.showErrorMessage(`GitHD: Unable to load branches. ${String(error).trim()}`);
      }
    }
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
      const [, files] = await this._gitService.getCommittedFiles(repo, compare.commit, base.commit, false, true);
      if (request !== this._request) {
        return;
      }
      this._files = files
        .sort((left, right) => left.gitRelativePath.localeCompare(right.gitRelativePath))
        .map(file => {
          const item = new vs.TreeItem(path.basename(file.gitRelativePath));
          const directory = path.dirname(file.gitRelativePath);
          item.description = directory === '.' ? file.status : `${file.status} | ${directory}`;
          item.tooltip =
            file.gitRelativeOldPath === file.gitRelativePath
              ? file.gitRelativePath
              : `${file.gitRelativeOldPath} -> ${file.gitRelativePath}`;
          const icon =
            file.status === 'A'
              ? 'diff-added'
              : file.status === 'D'
                ? 'diff-removed'
                : file.status === 'R'
                  ? 'diff-renamed'
                  : 'diff-modified';
          item.iconPath = new vs.ThemeIcon(icon, Resource.getGitStatusColor(file.status));
          item.command = {
            title: 'Open branch diff',
            command: 'githd.openCommittedFile',
            arguments: [
              file,
              { repo, leftRef: base.commit, rightRef: compare.commit },
              `${base.name} .. ${compare.name}`
            ]
          };
          return item;
        });
      this._view.description = `${files.length} changed file${files.length === 1 ? '' : 's'}`;
      this._view.message = files.length ? undefined : 'No differences between these branches.';
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
}
