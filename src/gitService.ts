import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import * as vs from 'vscode';
import { execSync, spawn } from 'child_process';
import { Tracer } from './tracer';
import { isEmptyHash } from './utils';
import { GitLineCounts, parseGitPath, parseNameStatus, parseNumStat } from './gitParser';

const EntrySeparator = '[githd-es]';
const FormatSeparator = '[githd-fs]';
// refs of the in-progress operations that may leave conflicted (staged) files in the index
const OperationRefs = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

// order of the fields in a log entry, see getLogEntries
enum LogItem {
  subject,
  hash,
  ref,
  author,
  email,
  timestamp,
  date,
  relativeDate,
  additional
}

function normalizeFilePath(fsPath: string): string {
  fsPath = path.normalize(fsPath);
  if (os.platform() == 'win32') {
    fsPath = fsPath.toLocaleLowerCase();
  }
  if (!fsPath.endsWith(path.sep)) {
    fsPath = fsPath + path.sep;
  }
  return fsPath;
}

export interface GitRepo {
  root: string;
  remoteUrl: string;
}

export enum GitRefType {
  Head,
  RemoteHead,
  Tag
}
export interface GitRef {
  type: GitRefType;
  name?: string;
  commit: string;
}

export interface GitLogEntry {
  subject: string;
  hash: string;
  ref: string;
  author: string;
  email: string;
  timestamp: number;
  date: string;
  relativeDate: string;
  stat?: string;
  lineInfo?: string;
}

export interface GitCommittedFile {
  fileUri: vs.Uri;
  oldFileUri: vs.Uri;
  gitRelativePath: string;
  gitRelativeOldPath: string;
  status: string;
  stat: string | undefined;
}

class GitCommittedFileImpl implements GitCommittedFile {
  constructor(
    private _repo: GitRepo,
    readonly gitRelativePath: string,
    readonly gitRelativeOldPath: string,
    readonly status: string
  ) {}

  stat: string | undefined;

  get fileUri(): vs.Uri {
    return vs.Uri.file(path.join(this._repo.root, this.gitRelativePath));
  }

  get oldFileUri(): vs.Uri {
    return vs.Uri.file(path.join(this._repo.root, this.gitRelativeOldPath));
  }
}

export interface GitBlameItem {
  file: vs.Uri;
  line: number;
  hash: string;
  history?: { file: vs.Uri; line: number; ref: string };
  subject?: string;
  body?: string;
  author?: string;
  date?: string;
  relativeDate?: string;
  email?: string;
  stat?: string;
}

// a merge stage (1: base, 2: ours, 3: theirs) of a conflicted file in the index
interface StagedFile {
  repo: GitRepo;
  file: vs.Uri;
  relativePath: string;
  stage: number;
  blob: string;
}

interface BlameInfo {
  hash: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  history?: GitBlameItem['history'];
}

function singleLined(value: string): string {
  return value.replace(/\r?\n|\r/g, ' ');
}

export class GitService {
  private _gitRepos: GitRepo[] = [];
  private _onDidChangeGitRepositories = new vs.EventEmitter<GitRepo[]>();
  private _onDidChangeCurrentGitRepo = new vs.EventEmitter<GitRepo>();
  private _gitPath: string;
  private _currentRepo: GitRepo | undefined;

  constructor(context: vs.ExtensionContext) {
    context.subscriptions.push(
      vs.workspace.onDidChangeWorkspaceFolders(_ => this.updateGitRoots(vs.workspace.workspaceFolders)),
      this._onDidChangeGitRepositories,
      this._onDidChangeCurrentGitRepo
    );
    let gitPath: string = vs.workspace.getConfiguration('git').get('path') ?? '';
    if (gitPath) {
      try {
        execSync(gitPath);
      } catch (err) {
        // fallback to 'git' without the path
        gitPath = 'git';
      }
    } else {
      gitPath = 'git';
    }
    this._gitPath = gitPath;
  }

  get onDidChangeGitRepositories(): vs.Event<GitRepo[]> {
    return this._onDidChangeGitRepositories.event;
  }

  get onDidChangeCurrentGitRepo(): vs.Event<GitRepo> {
    return this._onDidChangeCurrentGitRepo.event;
  }

  async updateGitRoots(wsFolders: readonly vs.WorkspaceFolder[] | undefined) {
    // reset repos first. Should optimize it to avoid firing multiple events.
    this._gitRepos = [];
    vs.commands.executeCommand('setContext', 'githd.hasGitRepo', false);
    this._onDidChangeGitRepositories.fire([]);

    const start = Date.now();
    const promises: Promise<number>[] = wsFolders
      ? wsFolders.map(wsFolder => this._scanFolder(wsFolder.uri.fsPath, true))
      : [Promise.resolve(0)];
    const count: number = await Promise.all(promises).then(results => results.reduce((a, b) => a + b, 0));
    if (count === 1) {
      this.updateCurrentGitRepo(this._gitRepos[0]);
    }
    Tracer.info(`updateGitRoots: ${wsFolders?.length} wsFolders ${count} subFolders (${Date.now() - start}ms)`);
  }

  getGitRepos(): GitRepo[] {
    return this._gitRepos;
  }

  get currentGitRepo(): GitRepo | undefined {
    return this._currentRepo;
  }

  updateCurrentGitRepo(repo: GitRepo) {
    this._currentRepo = repo;
    this._onDidChangeCurrentGitRepo.fire(repo);
  }

  async getGitRepo(fsPath: string): Promise<GitRepo | undefined> {
    while (!fs.existsSync(fsPath)) {
      const parent = path.dirname(fsPath);
      if (parent === fsPath) {
        return;
      }
      fsPath = parent;
    }
    if (fs.statSync(fsPath).isFile()) {
      fsPath = path.dirname(fsPath);
    }
    fsPath = normalizeFilePath(fsPath);
    let repo = this._gitRepos.find(r => fsPath.startsWith(r.root));
    if (repo) {
      return repo;
    }
    let root = (await this._exec(['rev-parse', '--show-toplevel'], fsPath)).trim();
    if (root) {
      root = normalizeFilePath(root);
      if (
        this._gitRepos.findIndex((value: GitRepo) => {
          return value.root == root;
        }) === -1
      ) {
        const remoteUrl = await this._getRemoteUrl(fsPath);
        repo = { root, remoteUrl };
        this._gitRepos.push(repo);
        vs.commands.executeCommand('setContext', 'githd.hasGitRepo', true);
        this._onDidChangeGitRepositories.fire(this.getGitRepos());
      }
    }
    return repo;
  }

  async getGitRelativePath(file?: vs.Uri): Promise<string | undefined> {
    if (!file) {
      return;
    }
    const repo = await this.getGitRepo(file.fsPath);
    if (!repo) {
      return;
    }
    let relative: string = path.relative(repo.root, file.fsPath).replace(/\\/g, '/');
    return relative === '' ? '.' : relative;
  }

  async getCurrentBranch(repo: GitRepo | undefined): Promise<string | undefined> {
    if (!repo) {
      return;
    }
    return (await this._exec(['rev-parse', '--abbrev-ref', 'HEAD'], repo.root)).trim();
  }

  async getCommitsCount(
    repo: GitRepo,
    branch: string,
    author?: string,
    startTime?: Date,
    endTime?: Date
  ): Promise<number> {
    if (!repo) {
      return 0;
    }
    let args: string[] = ['rev-list', '--simplify-merges', '--count', branch];
    if (author) {
      args.push(`--author=${author}`);
    }
    if (startTime) {
      args.push(`--after=${startTime.toISOString()}`);
    }
    if (endTime) {
      args.push(`--before=${endTime.toISOString()}`);
    }

    // the '--' is to avoid same branch and file names caused error
    args.push('--');

    return parseInt(await this._exec(args, repo.root));
  }

  async getRefs(repo: GitRepo, throwOnError = false): Promise<GitRef[]> {
    if (!repo) {
      return [];
    }
    const result = await this._exec(['for-each-ref', '--format=%(refname) %(objectname:short)'], repo.root, throwOnError);
    const fn = (line: string): GitRef | null => {
      let match: RegExpExecArray | null;

      if ((match = /^refs\/heads\/([^ ]+) ([0-9a-f]+)$/.exec(line))) {
        return { name: match[1], commit: match[2], type: GitRefType.Head };
      } else if ((match = /^refs\/remotes\/([^/]+)\/([^ ]+) ([0-9a-f]+)$/.exec(line))) {
        return {
          name: `${match[1]}/${match[2]}`,
          commit: match[3],
          type: GitRefType.RemoteHead
        };
      } else if ((match = /^refs\/tags\/([^ ]+) ([0-9a-f]+)$/.exec(line))) {
        return { name: match[1], commit: match[2], type: GitRefType.Tag };
      }

      return null;
    };

    return result
      .trim()
      .split('\n')
      .filter(line => !!line)
      .map(fn)
      .filter(ref => !!ref) as GitRef[];
  }

  // returns [total commits stats, [commits]]
  async getCommittedFiles(
    repo: GitRepo,
    rightRef: string,
    leftRef?: string,
    isStash?: boolean,
    throwOnError = false
  ): Promise<[string, GitCommittedFile[]]> {
    if (!repo) {
      return ['', []];
    }
    // -z keeps paths unquoted regardless of core.quotePath; the empty format and --no-show-signature
    // keep the commit header out of the output
    let args = ['show', '--no-show-signature', '--format=', '--name-status', '-z', rightRef];
    if (leftRef) {
      args = ['diff', '--name-status', '-z', `${leftRef}..${rightRef}`];
    } else if (isStash) {
      args.unshift('stash');
    }
    const result = await this._exec(args, repo.root, throwOnError);
    const files: GitCommittedFile[] = parseNameStatus(result).map(
      change => new GitCommittedFileImpl(repo, change.newPath, change.oldPath, change.status)
    );
    const stats: string = !leftRef && !isStash ? await this._updateCommitsStats(repo, rightRef, files) : '';
    return [stats, files];
  }

  // returns [gitRelativePath, line counts] for every file changed between the two refs.
  // Unless throwOnError is set, a failure yields an empty map.
  async getLineCounts(
    repo: GitRepo,
    leftRef: string,
    rightRef: string,
    throwOnError = false
  ): Promise<Map<string, GitLineCounts>> {
    if (!repo) {
      return new Map();
    }
    const result = await this._exec(['diff', '--numstat', '-z', `${leftRef}..${rightRef}`], repo.root, throwOnError);
    return parseNumStat(result);
  }

  async getLogEntries(
    repo: GitRepo,
    express: boolean,
    start: number,
    count: number,
    branch: string,
    isStash?: boolean,
    file?: vs.Uri,
    line?: number,
    author?: string,
    startTime?: Date,
    endTime?: Date
  ): Promise<GitLogEntry[]> {
    Tracer.info(
      `Get entries. repo: ${repo.root}, express: ${express}, start: ${start}, count: ${count}, branch: ${branch}, ` +
        `isStash: ${isStash}, file: ${file?.fsPath}, line: ${line}, author: ${author}, ` +
        `startTime: ${startTime?.toISOString()}, endTime: ${endTime?.toISOString()}`
    );
    if (!repo) {
      return [];
    }

    const args = await this._getLogArgs(express, start, count, branch, isStash, file, line, author, startTime, endTime);
    const result = await this._exec(args, repo.root);
    const entries: GitLogEntry[] = [];
    for (const entry of result.split(EntrySeparator)) {
      const parsed = this._parseLogEntry(entry, !!line);
      if (parsed) {
        entries.push(parsed);
      }
    }
    return entries;
  }

  private async _getLogArgs(
    express: boolean,
    start: number,
    count: number,
    branch: string,
    isStash?: boolean,
    file?: vs.Uri,
    line?: number,
    author?: string,
    startTime?: Date,
    endTime?: Date
  ): Promise<string[]> {
    const format =
      `%s${FormatSeparator}%h${FormatSeparator}%d${FormatSeparator}%aN${FormatSeparator}%ae${FormatSeparator}` +
      `%ct${FormatSeparator}%cd${FormatSeparator}%cr${FormatSeparator}`;
    const statArgs = !express && !line ? ['--shortstat'] : [];
    if (isStash) {
      return ['stash', 'list', `--format=${EntrySeparator}%gd:${format}`, '--date=local', ...statArgs];
    }
    return [
      'log',
      `--skip=${start}`,
      `--max-count=${count}`,
      '--date-order',
      '--simplify-merges',
      branch,
      `--format=${EntrySeparator}${format}`,
      '--date=local',
      ...statArgs,
      ...this._getLogFilterArgs(author, startTime, endTime),
      ...(await this._getLogPathArgs(file, line))
    ];
  }

  private _getLogFilterArgs(author?: string, startTime?: Date, endTime?: Date): string[] {
    const args: string[] = [];
    if (author) {
      args.push(`--author=${author}`);
    }
    if (startTime) {
      args.push(`--after=${startTime.toISOString()}`);
    }
    if (endTime) {
      args.push(`--before=${endTime.toISOString()}`);
    }
    return args;
  }

  private async _getLogPathArgs(file?: vs.Uri, line?: number): Promise<string[]> {
    if (!file) {
      // the '--' is to avoid same branch and file names caused error
      return ['--'];
    }
    const filePath = (await this.getGitRelativePath(file)) ?? '.';
    return line ? [`-L ${line},${line}:${filePath}`, '--'] : ['--follow', '--', filePath];
  }

  // parses one entry of the output of _getLogArgs. The trailing field is the line history when
  // hasLine is set, the shortstat otherwise.
  private _parseLogEntry(entry: string, hasLine: boolean): GitLogEntry | undefined {
    const items = entry.split(FormatSeparator);
    if (items.length <= LogItem.additional) {
      return;
    }
    const additional = items[LogItem.additional].trim();
    return {
      subject: singleLined(items[LogItem.subject]),
      hash: items[LogItem.hash],
      ref: items[LogItem.ref],
      author: items[LogItem.author],
      email: items[LogItem.email],
      timestamp: parseInt(items[LogItem.timestamp]),
      date: items[LogItem.date],
      relativeDate: items[LogItem.relativeDate],
      stat: hasLine ? undefined : additional,
      lineInfo: hasLine ? additional : undefined
    };
  }

  async getCommitDetails(repo: GitRepo | undefined, ref: string, isStash?: boolean): Promise<string> {
    if (!repo) {
      return '';
    }

    const format: string = isStash
      ? `Stash:         %H %nAuthor:        %aN <%aE> %nAuthorDate:    %ad %n%n%s %n`
      : 'Commit:        %H %nAuthor:        %aN <%aE> %nAuthorDate:    %ad %nCommit:        %cN <%cE> %nCommitDate:    %cd %n%n%s %n';
    let details: string = await this._exec(
      ['show', `--format=${format}`, '--no-patch', '--date=local', ref],
      repo.root
    );
    const body = (await this._exec(['show', '--format=%b', '--no-patch', ref], repo.root)).trim();
    if (body) {
      details += body + '\r\n\r\n';
    }
    details += '-----------------------------\r\n\r\n';
    details += await this._exec(['show', '--format=', '--stat', '--stat-width=120', ref], repo.root);
    return details;
  }

  async getAuthors(repo: GitRepo): Promise<{ name: string; email: string }[]> {
    if (!repo) {
      return [];
    }
    const result: string = (await this._exec(['shortlog', '-se', 'HEAD'], repo.root)).trim();
    return result.split(/\r?\n/g).map(item => {
      item = item.trim();
      let start: number = item.search(/ |\t/);
      item = item.substring(start + 1).trim();
      start = item.indexOf('<');

      const name: string = item.substring(0, start);
      const email: string = item.substring(start + 1, item.length - 1);
      return { name, email };
    });
  }

  getFileRevision(file: vs.Uri): { file: vs.Uri; ref?: string; useContents: boolean; stage?: number } | undefined {
    if (file.scheme === 'file') {
      return { file, useContents: false };
    }
    if (file.scheme !== 'git') {
      return;
    }
    const params = this._parseGitUriQuery(file.query);
    if (!params) {
      return;
    }
    const { path: filePath, ref } = params;
    const stage = /^[:~]([1-3])$/.exec(ref);
    if (stage) {
      return { file: vs.Uri.file(filePath), useContents: true, stage: Number(stage[1]) };
    }
    const useContents = !ref || ref === '~' || /^[:~][0-3]$/.test(ref);
    return { file: vs.Uri.file(filePath), ref: useContents ? undefined : ref, useContents };
  }

  // parses the query of a vscode 'git:' uri into the file path and the ref it points at
  private _parseGitUriQuery(query: string): { path: string; ref: string } | undefined {
    try {
      const params = JSON.parse(query);
      if (!params || params.submoduleOf) {
        return;
      }
      const { path: filePath, ref = '' } = params;
      if (typeof filePath !== 'string' || typeof ref !== 'string') {
        return;
      }
      return { path: filePath, ref };
    } catch {
      return;
    }
  }

  private async _resolveFileRevision(file: vs.Uri): Promise<{ file: vs.Uri; ref?: string; useContents: boolean } | undefined> {
    const source = this.getFileRevision(file);
    if (!source?.stage) {
      return source;
    }
    const repo = await this.getGitRepo(source.file.fsPath);
    if (!repo) {
      return;
    }
    const relativePath = path.relative(repo.root, source.file.fsPath).split(path.sep).join('/');
    const blob = (await this._exec(
      ['rev-parse', '--verify', '--quiet', `:${source.stage}:${relativePath}`], repo.root
    )).trim();
    if (!blob) {
      return;
    }

    const staged: StagedFile = { repo, file: source.file, relativePath, stage: source.stage, blob };
    const refs = source.stage === 2 ? ['HEAD'] : OperationRefs;
    for (const ref of refs) {
      const matches = await this._findStagedFileMatches(staged, ref);
      if (matches.length > 0) {
        // more than one match means the revision is ambiguous, give up
        return matches.length === 1 ? { ...matches[0], useContents: false } : undefined;
      }
    }
  }

  // returns the commits reachable from the operation ref that may hold the given stage of the file
  private async _getStageCommits(repo: GitRepo, stage: number, ref: string): Promise<string[]> {
    const commit = (await this._exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo.root)).trim();
    if (!commit) {
      return [];
    }
    const useParents = ref === 'REVERT_HEAD' ? stage === 3 : stage === 1;
    if (!useParents) {
      return [commit];
    }
    if (ref === 'MERGE_HEAD') {
      return (await this._exec(['merge-base', '--all', 'HEAD', commit], repo.root)).trim().split(/\s+/).filter(Boolean);
    }
    return this._getParentCommits(repo, commit);
  }

  private async _getParentCommits(repo: GitRepo, commit: string): Promise<string[]> {
    const result = await this._exec(['rev-list', '--parents', '-n', '1', commit], repo.root);
    return result.trim().split(/\s+/).slice(1).filter(Boolean);
  }

  // returns the [file, commit] pairs holding the staged content among the commits of the operation ref,
  // either at the same path or at a path which was renamed to it
  private async _findStagedFileMatches(staged: StagedFile, ref: string): Promise<{ file: vs.Uri; ref: string }[]> {
    const { repo, relativePath, blob } = staged;
    const commits = await this._getStageCommits(repo, staged.stage, ref);
    const exactCommits = await this._filterCommitsWithBlob(staged, commits);
    if (exactCommits.length > 0) {
      return exactCommits.map(commit => ({ file: staged.file, ref: commit }));
    }

    const targetRefs = staged.stage === 2 ? OperationRefs : ['HEAD', ref];
    const renamed: { file: vs.Uri; ref: string }[] = [];
    for (const commit of commits) {
      const paths = await this._findBlobPaths(repo, commit, blob);
      if (paths.length === 1 && commits.length === 1) {
        return [{ file: vs.Uri.file(path.join(repo.root, paths[0])), ref: commit }];
      }
      if (paths.length > 0) {
        const renamedPaths = await this._findRenamedPaths(repo, commit, paths, relativePath, targetRefs);
        for (const filename of renamedPaths) {
          renamed.push({ file: vs.Uri.file(path.join(repo.root, filename)), ref: commit });
        }
      }
    }
    return renamed;
  }

  // returns the commits in which the file has the staged content at the same path
  private async _filterCommitsWithBlob(staged: StagedFile, commits: string[]): Promise<string[]> {
    const { repo, relativePath, blob } = staged;
    const result: string[] = [];
    for (const commit of commits) {
      const commitBlob = (
        await this._exec(['rev-parse', '--verify', '--quiet', `${commit}:${relativePath}`], repo.root)
      ).trim();
      if (commitBlob === blob) {
        result.push(commit);
      }
    }
    return result;
  }

  // returns the paths of all the files in the commit whose content is the blob
  private async _findBlobPaths(repo: GitRepo, commit: string, blob: string): Promise<string[]> {
    const entries = (await this._exec(['ls-tree', '-r', '--full-tree', '-z', commit], repo.root)).split('\0');
    return entries
      .filter(entry => entry.substring(0, entry.indexOf('\t')).split(' ')[2] === blob)
      .map(entry => entry.substring(entry.indexOf('\t') + 1));
  }

  // returns the paths (among `paths`) of the commit which are renamed to relativePath in any of the target refs
  private async _findRenamedPaths(
    repo: GitRepo,
    commit: string,
    paths: string[],
    relativePath: string,
    targetRefs: string[]
  ): Promise<Set<string>> {
    const renamedPaths = new Set<string>();
    for (const targetRef of targetRefs) {
      const target = (
        await this._exec(['rev-parse', '--verify', '--quiet', `${targetRef}^{commit}`], repo.root)
      ).trim();
      if (!target) {
        continue;
      }
      const targets = targetRef === 'REVERT_HEAD' ? await this._getParentCommits(repo, target) : [target];
      for (const targetCommit of targets.filter(value => value !== commit)) {
        const renames = (
          await this._exec(
            ['diff', '--name-status', '--find-renames', '--diff-filter=R', '-z', commit, targetCommit],
            repo.root
          )
        ).split('\0');
        for (let offset = 0; offset + 2 < renames.length; offset += 3) {
          if (renames[offset + 2] === relativePath && paths.includes(renames[offset + 1])) {
            renamedPaths.add(renames[offset + 1]);
          }
        }
      }
    }
    return renamedPaths;
  }

  async getHistoryRevision(file: vs.Uri, line?: number): Promise<{ file: vs.Uri; ref?: string; line?: number } | undefined> {
    const source = await this._resolveFileRevision(file);
    if (!source) {
      return;
    }
    if (!source.useContents) {
      return { file: source.file, ref: source.ref, line };
    }
    if (line !== undefined) {
      return (await this.getBlameItem(file, line))?.history;
    }

    const repo = await this.getGitRepo(source.file.fsPath);
    if (!repo) {
      return;
    }
    const ref = (await this._exec(['rev-parse', '--verify', '--quiet', 'HEAD'], repo.root)).trim();
    if (!ref) {
      return;
    }
    const renames = (await this._exec(
      ['diff', '--cached', '--name-status', '--find-renames', '--diff-filter=R', '-z', ref],
      repo.root
    )).split('\0');
    for (let offset = 0; offset + 2 < renames.length; offset += 3) {
      if (normalizeFilePath(path.join(repo.root, renames[offset + 2])) === normalizeFilePath(source.file.fsPath)) {
        return { file: vs.Uri.file(path.join(repo.root, renames[offset + 1])), ref };
      }
    }
    return { file: source.file, ref };
  }

  async getBlameItem(file: vs.Uri, line: number): Promise<GitBlameItem | undefined> {
    const source = await this._resolveFileRevision(file);
    if (!source) {
      return;
    }

    const filePath = source.file.fsPath;
    const repo = await this.getGitRepo(filePath);
    if (!repo) {
      return;
    }

    const args = ['-c', 'core.quotePath=false', 'blame', '-L', `${line + 1},${line + 1}`, '--incremental', '--root'];
    let contents: Uint8Array | undefined;
    if (source.useContents) {
      const document = await vs.workspace.openTextDocument(file);
      contents = await vs.workspace.encode(document.getText(), { encoding: document.encoding });
      if (!(await this._exec(['rev-parse', '--verify', '--quiet', 'HEAD'], repo.root)).trim()) {
        return { file, line, hash: '0000000000000000000000000000000000000000' };
      }
      args.push('--contents', '-');
    } else if (source.ref) {
      args.push(source.ref);
    }
    args.push('--', filePath);
    const result = await this._exec(args, repo.root, false, contents);
    const blame = this._parseBlame(result, repo);
    const { hash, subject, author, email, date } = blame;
    if ([hash, subject, author, email, date].some(v => !v)) {
      Tracer.warning(
        `Blame info missed. repo ${repo.root} file ${filePath}:${line} ${hash}` +
          ` author: ${author}, mail: ${email}, date: ${date}, summary: ${subject}`
      );
      return;
    }

    if (isEmptyHash(hash)) {
      Tracer.verbose(`Blame info skipped. repo ${repo.root} file ${filePath}:${line} ${hash}`);
      return { file, line, hash };
    }

    // the commit info replaces the full hash with the abbreviated one
    const commit = await this._getBlameCommitInfo(repo, hash);
    return { file, line, ...blame, ...commit };
  }

  // parses the output of 'git blame --incremental' for a single line
  private _parseBlame(output: string, repo: GitRepo): BlameInfo {
    let hash = '';
    let originalLine = -1;
    let originalFile: vs.Uri | undefined;
    let subject = '';
    let author = '';
    let date = '';
    let email = '';
    output.split(/\r?\n/g).forEach((line, index) => {
      if (index == 0) {
        const fields = line.split(' ');
        hash = fields[0];
        originalLine = Number(fields[1]) - 1;
      } else {
        const infoName = line.split(' ')[0];
        if (infoName === 'filename') {
          originalFile = vs.Uri.file(path.join(repo.root, parseGitPath(line.substring(infoName.length + 1))));
          return;
        }
        const info = line.substring(infoName.length).trim();
        if (!info) {
          return;
        }
        switch (infoName) {
          case 'author':
            author = info;
            break;
          case 'committer-time':
            date = new Date(parseInt(info) * 1000).toLocaleDateString();
            break;
          case 'author-mail':
            email = info;
            break;
          case 'summary':
            subject = singleLined(info);
            break;
          default:
            break;
        }
      }
    });

    const history =
      originalFile && Number.isInteger(originalLine) && originalLine >= 0
        ? { file: originalFile, line: originalLine, ref: hash }
        : undefined;
    return { hash, subject, author, email, date, history };
  }

  // get additional info of the commit: abbrev hash, relative date, body, stat
  private async _getBlameCommitInfo(
    repo: GitRepo,
    hash: string
  ): Promise<{ hash: string; relativeDate: string; body: string; stat: string }> {
    const addition: string = await this._exec(
      ['show', `--format=%h${FormatSeparator}%cr${FormatSeparator}%b${FormatSeparator}`, '--stat', `${hash}`],
      repo.root
    );
    const items = addition.split(FormatSeparator);
    return {
      hash: items[0] ?? '',
      relativeDate: items[1] ?? '',
      body: items[2]?.trim() ?? '',
      stat: ' ' + items[3]?.trim()
    };
  }

  // commits will be updated with stats
  private async _updateCommitsStats(repo: GitRepo, ref: string, commits: GitCommittedFile[]): Promise<string> {
    const res: string = await this._exec(
      ['show', '--no-show-signature', '--format=', '--stat', '--stat-width=200', ref],
      repo.root
    );
    const stats = new Map<string, string>(); // [oldFilePath, stat]
    let total = '';
    res.split(/\r?\n/g).forEach(line => {
      const items = line.split('|');
      if (items.length == 2) {
        stats.set(parseGitPath(items[0].trim()), items[1].trim()); // TODO: rename is not handled
      } else if (line.indexOf('changed') > 0) {
        total = line;
      }
    });

    commits.forEach(commit => (commit.stat = stats.get(commit.gitRelativeOldPath)));
    return total;
  }

  async getCommits(repo: GitRepo, branch?: string): Promise<string[]> {
    if (!branch) {
      return [];
    }

    const result: string = await this._exec(
      ['log', '--format=%h', '--simplify-merges', '--date-order', branch, '--'],
      repo.root
    );
    return result.split(/\r?\n/g);
  }

  private async _scanFolder(folder: string, includeSubFolders?: boolean): Promise<number> {
    const children = fs.readdirSync(folder, { withFileTypes: true });
    const promises = children
      .filter(child => child.isDirectory() || child.isFile())
      .map(async child => {
        if (child.name === '.git') {
          await this.getGitRepo(folder);
          return 1;
        }
        if (includeSubFolders && child.isDirectory()) {
          return await this._scanFolder(path.join(folder, child.name));
        }
        return 0;
      });
    return await Promise.all(promises).then(results => results.reduce((a, b) => a + b, 0));
  }

  private async _getRemoteUrl(fsPath: string): Promise<string> {
    let remotes = (await this._exec(['remote'], fsPath)).split(/\r?\n/g);
    const remote = remotes.find(r => r === 'upstream') || remotes.find(r => r === 'origin');
    if (!remote) {
      return '';
    }

    let remoteGit = (await this._exec(['remote', 'get-url', '--push', remote], fsPath)).trim();
    if (remoteGit.startsWith('git@')) {
      remoteGit = remoteGit.replace(':', '/').replace('git@', 'https://');
    }
    let url = remoteGit.replace(/\.git$/g, '');
    // Do a best guess if it's a valid git repository url. In case user configs
    // the host name.
    if (url.search(/\.(com|org|net|io|cloud)\//g) > 0) {
      return url;
    }

    Tracer.info('Remote URL: ' + remoteGit);
    // If it's not considered as a valid one, we try to compose a github one.
    return url.replace(/:\/\/.*?\//g, '://github.com/');
  }

  private async _exec(args: string[], cwd: string, throwOnError = false, input?: string | Uint8Array): Promise<string> {
    const start = Date.now();
    const cmd = this._gitPath;

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const childProcess = spawn(cmd, args, { cwd });
        childProcess.stdout.setEncoding('utf8');
        childProcess.stderr.setEncoding('utf8');
        let stdout = '',
          stderr = '';
        childProcess.stdout.on('data', chunk => {
          stdout += chunk;
        });
        childProcess.stderr.on('data', chunk => {
          stderr += chunk;
        });
        childProcess.on('error', reject).on('close', code => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(stderr);
          }
        });
        if (input !== undefined) {
          childProcess.stdin.on('error', reject);
          childProcess.stdin.end(input);
        }
      });

      Tracer.verbose(
        `git command: ${cmd} ${args.join(' ')}. Output size: ${result.length} (${Date.now() - start}ms) ${cwd}`
      );
      return result;
    } catch (err) {
      Tracer.error(`git command failed: ${cmd} ${args.join(' ')} (${Date.now() - start}ms) ${cwd} ${err}`);
      if (throwOnError) {
        throw err;
      }
      return '';
    }
  }
}
