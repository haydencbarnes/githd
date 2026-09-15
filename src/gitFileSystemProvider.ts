import * as vs from 'vscode';

import { GitService, GitRepo } from './gitService';
import { GitObjectType } from './gitParser';
import { GitRevisionScheme, fromGitRevisionUri } from './gitUri';
import { Tracer } from './tracer';

// A revision named by a hash, optionally walked back with ~ and ^, never changes. A branch or a tag
// may move.
const immutableRef = /^[0-9a-f]{7,64}([~^]\d*)*$/i;

function toFileType(type: GitObjectType, mode?: string): vs.FileType {
  switch (type) {
    case 'tree':
      return vs.FileType.Directory;
    case 'commit':
      // a submodule, whose content is not in this repository
      return vs.FileType.Unknown;
    default:
      return mode === '120000' ? vs.FileType.File | vs.FileType.SymbolicLink : vs.FileType.File;
  }
}

// Serves the files of a repository at a revision (see gitUri.ts) to vscode. The diff editors are
// opened on these uris rather than on those of the git extension, whose provider does not list
// folders: this way the breadcrumbs of a diff editor can browse the folders of the revision.
export class GitFileSystemProvider implements vs.FileSystemProvider {
  private readonly _onDidChangeFile = new vs.EventEmitter<vs.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(
    context: vs.ExtensionContext,
    private _gitService: GitService
  ) {
    context.subscriptions.push(
      vs.workspace.registerFileSystemProvider(GitRevisionScheme, this, { isReadonly: true, isCaseSensitive: true }),
      this._onDidChangeFile
    );
  }

  watch(): vs.Disposable {
    // changes are never reported: a revision is reloaded through stat (see its mtime)
    return new vs.Disposable(() => {});
  }

  async stat(uri: vs.Uri): Promise<vs.FileStat> {
    const { repo, ref, relativePath } = await this._locate(uri);
    const details = await this._gitService.getObjectDetails(repo, ref, relativePath);
    if (!details) {
      throw vs.FileSystemError.FileNotFound(uri);
    }
    // vscode reads a file again only when its mtime or size changed
    const mtime = immutableRef.test(ref) ? 0 : Date.now();
    return { type: toFileType(details.type), ctime: 0, mtime, size: details.size };
  }

  async readDirectory(uri: vs.Uri): Promise<[string, vs.FileType][]> {
    const { repo, ref, relativePath } = await this._locate(uri);
    const entries = await this._gitService.listTree(repo, ref, relativePath);
    return entries.map(entry => [entry.name, toFileType(entry.type, entry.mode)]);
  }

  async readFile(uri: vs.Uri): Promise<Uint8Array> {
    const { repo, ref, relativePath } = await this._locate(uri);
    try {
      return await this._gitService.readFileAtRevision(repo, ref, relativePath);
    } catch (err) {
      Tracer.warning(`GitFileSystemProvider: cannot read ${uri.toString(true)}: ${err}`);
      throw vs.FileSystemError.FileNotFound(uri);
    }
  }

  createDirectory(uri: vs.Uri): void {
    throw vs.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vs.Uri): void {
    throw vs.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vs.Uri): void {
    throw vs.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vs.Uri): void {
    throw vs.FileSystemError.NoPermissions(oldUri);
  }

  private async _locate(uri: vs.Uri): Promise<{ repo: GitRepo; ref: string; relativePath: string }> {
    const location = fromGitRevisionUri(uri);
    // the repository may not be known yet when vscode restores the editors of a previous session
    const repo = location ? await this._gitService.getGitRepo(location.root) : undefined;
    if (!location || repo?.root !== location.root) {
      Tracer.warning(`GitFileSystemProvider: no repository for ${uri.toString(true)}`);
      throw vs.FileSystemError.FileNotFound(uri);
    }
    return { repo, ref: location.ref, relativePath: location.relativePath };
  }
}
