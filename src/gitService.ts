import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import * as vs from 'vscode';
import { execFile, spawn } from 'child_process';
import { LRUCache } from 'lru-cache';
import { Tracer } from './tracer';
import { isEmptyHash } from './utils';
import {
  GitBlameLine,
  GitLineCounts,
  GitObjectDetails,
  GitTreeEntry,
  parseBlameIncremental,
  parseGitPath,
  parseLsTree,
  parseNameStatus,
  parseNumStat,
  parseObjectDetails
} from './gitParser';
import { fromGitRevisionUri } from './gitUri';

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

interface BlameCommitInfo {
  hash: string;
  relativeDate: string;
  body: string;
  stat: string;
}

// the source of a blame: the file and either the revision or the (staged / working) contents
interface BlameSource {
  file: vs.Uri;
  ref?: string;
  useContents: boolean;
}

function singleLined(value: string): string {
  return value.replace(/\r?\n|\r/g, ' ');
}

function isCommitHash(ref: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(ref);
}

export class GitService {
  private _gitRepos: GitRepo[] = [];
  private _onDidChangeGitRepositories = new vs.EventEmitter<GitRepo[]>();
  private _onDidChangeCurrentGitRepo = new vs.EventEmitter<GitRepo>();
  private _gitPath = 'git';
  private _currentRepo: GitRepo | undefined;

  // commit details are immutable for a given hash
  private _commitDetails = new LRUCache<string, string>({ max: 100 });
  // the relative date of a commit ages, so the blame commit info is only kept for a short while
  private _blameCommitInfo = new LRUCache<string, BlameCommitInfo>({ max: 200, ttl: 60 * 1000 });
  // whole-file blames keyed by file, revision, HEAD and document version (see _getBlameCacheKey)
  private _fileBlames = new LRUCache<string, Map<number, GitBlameLine>>({ max: 4 });
  private _pendingFileBlames = new Set<string>();

  constructor(context: vs.ExtensionContext) {
    context.subscriptions.push(
      vs.workspace.onDidChangeWorkspaceFolders(_ => this.updateGitRoots(vs.workspace.workspaceFolders)),
      this._onDidChangeGitRepositories,
      this._onDidChangeCurrentGitRepo
    );
    this._resolveGitPath(vs.workspace.getConfiguration('git').get<string | string[] | null>('path'));
  }

  // Uses the git of the 'git.path' setting once it is verified to run, 'git' from the PATH otherwise.
  private async _resolveGitPath(configured: string | string[] | null | undefined): Promise<void> {
    const candidates = (Array.isArray(configured) ? configured : [configured]).filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0
    );
    for (const candidate of candidates) {
      const runs = await new Promise<boolean>(resolve => execFile(candidate, ['--version'], error => resolve(!error)));
      if (runs) {
        this._gitPath = candidate;
        return;
      }
      Tracer.warning(`git.path '${candidate}' cannot be executed, falling back to 'git'`);
    }
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

  // Lists the branches the remotes' HEADs point at (e.g. origin/main), which is how a clone records
  // the default branch of each remote. Empty when no remote HEAD is set, e.g. after `git init`.
  async getRemoteDefaultBranches(repo: GitRepo | undefined): Promise<string[]> {
    if (!repo) {
      return [];
    }
    const result = await this._exec(['for-each-ref', '--format=%(symref:short)', 'refs/remotes/*/HEAD'], repo.root);
    return result
      .split('\n')
      .map(line => line.trim())
      .filter(line => !!line);
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
    // the '--' is to avoid same branch and file names caused error
    const args = ['rev-list', '--count', branch, ...this._getLogFilterArgs(author, startTime, endTime), '--'];
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
    // the stats need a second git run, let it run concurrently with the file list
    const statsRequest = !leftRef && !isStash ? this._getCommitStats(repo, rightRef) : undefined;
    const result = await this._exec(args, repo.root, throwOnError);
    const files: GitCommittedFile[] = parseNameStatus(result).map(
      change => new GitCommittedFileImpl(repo, change.newPath, change.oldPath, change.status)
    );
    if (!statsRequest) {
      return ['', files];
    }
    const [total, stats] = await statsRequest;
    files.forEach(file => (file.stat = stats.get(file.gitRelativeOldPath)));
    return [total, files];
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
    // History simplification only takes effect with a path. Without one, --simplify-merges just
    // forces git to walk the whole history before printing the first commit.
    const simplifyArgs = file ? ['--simplify-merges'] : [];
    return [
      'log',
      `--skip=${start}`,
      `--max-count=${count}`,
      '--date-order',
      ...simplifyArgs,
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

    const cacheKey = !isStash && isCommitHash(ref) ? `${repo.root}\0${ref}` : undefined;
    const cached = cacheKey ? this._commitDetails.get(cacheKey) : undefined;
    if (cached !== undefined) {
      return cached;
    }

    const format: string = isStash
      ? `Stash:         %H %nAuthor:        %aN <%aE> %nAuthorDate:    %ad %n%n%s %n`
      : 'Commit:        %H %nAuthor:        %aN <%aE> %nAuthorDate:    %ad %nCommit:        %cN <%cE> %nCommitDate:    %cd %n%n%s %n';
    // The header, body and stat come from a single run. git terminates the format with a newline
    // and separates it from the stat with a blank line.
    const output = await this._exec(
      [
        'show',
        `--format=${format}${FormatSeparator}%b${FormatSeparator}`,
        '--stat',
        '--stat-width=120',
        '--date=local',
        ref
      ],
      repo.root
    );
    const details = this._formatCommitDetails(output);
    if (cacheKey && output) {
      this._commitDetails.set(cacheKey, details);
    }
    return details;
  }

  private _formatCommitDetails(output: string): string {
    const [header = '', rawBody = '', rawStat = ''] = output.split(FormatSeparator);
    let details = header ? header + '\n' : '';
    const body = rawBody.trim();
    if (body) {
      details += body + '\r\n\r\n';
    }
    details += '-----------------------------\r\n\r\n';
    details += rawStat.replace(/^\r?\n(\r?\n)?/, '');
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

  // Describes the object at the path of a revision, undefined when there is none. The path is
  // relative to the repository root, '' for the root itself.
  async getObjectDetails(repo: GitRepo, ref: string, relativePath: string): Promise<GitObjectDetails | undefined> {
    const output = await this._exec(['cat-file', '--batch-check'], repo.root, false, `${ref}:${relativePath}\n`);
    return parseObjectDetails(output);
  }

  // Lists the entries of the folder at the path of a revision, empty when there is no such folder.
  async listTree(repo: GitRepo, ref: string, relativePath: string): Promise<GitTreeEntry[]> {
    return parseLsTree(await this._exec(['ls-tree', '-z', '-l', `${ref}:${relativePath}`], repo.root));
  }

  // The content of the file at the path of a revision (with the textconv filters applied, like the
  // git extension does). Rejects when there is no such file.
  readFileAtRevision(repo: GitRepo, ref: string, relativePath: string): Promise<Uint8Array> {
    return this._execBuffer(['show', '--textconv', `${ref}:${relativePath}`], repo.root);
  }

  // Resolves an editor document to the file on disk it shows and, when it shows a revision (the
  // diff editors of githd or of the git extension), to the revision.
  getFileRevision(file: vs.Uri): { file: vs.Uri; ref?: string; useContents: boolean; stage?: number } | undefined {
    if (file.scheme === 'file') {
      return { file, useContents: false };
    }
    const revision = fromGitRevisionUri(file);
    if (revision) {
      return {
        file: vs.Uri.file(path.join(revision.root, revision.relativePath)),
        ref: revision.ref,
        useContents: false
      };
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

    const repo = await this.getGitRepo(source.file.fsPath);
    if (!repo) {
      return;
    }

    // HEAD is part of the blame cache key: a commit, checkout or reset changes the blame
    const head = (await this._exec(['rev-parse', '--verify', '--quiet', 'HEAD'], repo.root)).trim();
    if (source.useContents && !head) {
      return { file, line, hash: '0000000000000000000000000000000000000000' };
    }
    const document = source.useContents ? await vs.workspace.openTextDocument(file) : undefined;
    const contents = document
      ? await vs.workspace.encode(document.getText(), { encoding: document.encoding })
      : undefined;

    const cacheKey = this._getBlameCacheKey(repo, file, source, head, document?.version);
    const blame = await this._blameLine(repo, source, contents, cacheKey, line);
    if (!blame) {
      return;
    }

    if (isEmptyHash(blame.hash)) {
      Tracer.verbose(`Blame info skipped. repo ${repo.root} file ${source.file.fsPath}:${line} ${blame.hash}`);
      return { file, line, hash: blame.hash };
    }

    // the commit info replaces the full hash with the abbreviated one
    const commit = await this._getBlameCommitInfo(repo, blame.hash);
    return { file, line, ...blame, ...commit };
  }

  // Blames one line, undefined when git reports no (complete) blame for it.
  private async _blameLine(
    repo: GitRepo,
    source: BlameSource,
    contents: Uint8Array | undefined,
    cacheKey: string | undefined,
    line: number
  ): Promise<BlameInfo | undefined> {
    const lineBlame = await this._getLineBlame(repo, source, contents, cacheKey, line);
    const blame = lineBlame ? this._toBlameInfo(repo, lineBlame) : undefined;
    if (!blame || [blame.hash, blame.subject, blame.author, blame.email, blame.date].some(v => !v)) {
      Tracer.warning(
        `Blame info missed. repo ${repo.root} file ${source.file.fsPath}:${line} ${blame?.hash}` +
          ` author: ${blame?.author}, mail: ${blame?.email}, date: ${blame?.date}, summary: ${blame?.subject}`
      );
      return;
    }
    return blame;
  }

  // The key of the whole-file blame cache, undefined when the blamed contents cannot be pinned down:
  // - staged / working contents: the version of the document they were read from
  // - a revision: fixed by the revision itself
  // - the working tree file: the version of its open, saved document
  private _getBlameCacheKey(
    repo: GitRepo,
    file: vs.Uri,
    source: BlameSource,
    head: string,
    version: number | undefined
  ): string | undefined {
    if (!source.useContents && !source.ref) {
      const document = vs.workspace.textDocuments.find(doc => doc.uri.toString() === file.toString());
      if (!document || document.isDirty) {
        return undefined;
      }
      version = document.version;
    }
    return `${repo.root}\0${file.toString()}\0${source.ref ?? ''}\0${head}\0${version ?? ''}`;
  }

  private _getBlameArgs(source: BlameSource, line?: number): string[] {
    const args = ['-c', 'core.quotePath=false', 'blame', '--incremental', '--root'];
    if (line !== undefined) {
      args.push('-L', `${line + 1},${line + 1}`);
    }
    if (source.useContents) {
      args.push('--contents', '-');
    } else if (source.ref) {
      args.push(source.ref);
    }
    args.push('--', source.file.fsPath);
    return args;
  }

  // Returns the blame of one line: from the whole-file blame when it is cached, otherwise from a
  // single-line blame while the whole file gets blamed in the background for the next requests.
  private async _getLineBlame(
    repo: GitRepo,
    source: BlameSource,
    contents: Uint8Array | undefined,
    cacheKey: string | undefined,
    line: number
  ): Promise<GitBlameLine | undefined> {
    const cached = cacheKey ? this._fileBlames.get(cacheKey) : undefined;
    if (cached) {
      return cached.get(line);
    }
    const result = await this._exec(this._getBlameArgs(source, line), repo.root, false, contents);
    if (cacheKey) {
      this._cacheFileBlame(cacheKey, repo, source, contents);
    }
    return parseBlameIncremental(result).get(line);
  }

  private _cacheFileBlame(cacheKey: string, repo: GitRepo, source: BlameSource, contents: Uint8Array | undefined) {
    if (this._pendingFileBlames.has(cacheKey)) {
      return;
    }
    this._pendingFileBlames.add(cacheKey);
    this._exec(this._getBlameArgs(source), repo.root, false, contents)
      .then(output => {
        const lines = parseBlameIncremental(output);
        if (lines.size > 0) {
          this._fileBlames.set(cacheKey, lines);
        }
      })
      .finally(() => this._pendingFileBlames.delete(cacheKey));
  }

  private _toBlameInfo(repo: GitRepo, { commit, originalLine, filename }: GitBlameLine): BlameInfo {
    const history =
      filename && originalLine >= 0
        ? { file: vs.Uri.file(path.join(repo.root, filename)), line: originalLine, ref: commit.hash }
        : undefined;
    return {
      hash: commit.hash,
      subject: singleLined(commit.summary),
      author: commit.author,
      email: commit.email,
      date: commit.committerTime ? new Date(parseInt(commit.committerTime) * 1000).toLocaleDateString() : '',
      history
    };
  }

  // get additional info of the commit: abbrev hash, relative date, body, stat
  private async _getBlameCommitInfo(repo: GitRepo, hash: string): Promise<BlameCommitInfo> {
    const key = `${repo.root}\0${hash}`;
    const cached = this._blameCommitInfo.get(key);
    if (cached) {
      return cached;
    }
    const addition: string = await this._exec(
      ['show', `--format=%h${FormatSeparator}%cr${FormatSeparator}%b${FormatSeparator}`, '--stat', `${hash}`],
      repo.root
    );
    const items = addition.split(FormatSeparator);
    const info: BlameCommitInfo = {
      hash: items[0] ?? '',
      relativeDate: items[1] ?? '',
      body: items[2]?.trim() ?? '',
      stat: ' ' + items[3]?.trim()
    };
    if (addition) {
      this._blameCommitInfo.set(key, info);
    }
    return info;
  }

  // returns [total stat, [old file path, file stat]] of the commit
  private async _getCommitStats(repo: GitRepo, ref: string): Promise<[string, Map<string, string>]> {
    const res: string = await this._exec(
      ['show', '--no-show-signature', '--format=', '--stat', '--stat-width=200', ref],
      repo.root
    );
    const stats = new Map<string, string>();
    let total = '';
    res.split(/\r?\n/g).forEach(line => {
      const items = line.split('|');
      if (items.length == 2) {
        stats.set(parseGitPath(items[0].trim()), items[1].trim()); // TODO: rename is not handled
      } else if (line.indexOf('changed') > 0) {
        total = line;
      }
    });
    return [total, stats];
  }

  async getCommits(repo: GitRepo, branch?: string): Promise<string[]> {
    if (!branch) {
      return [];
    }

    // no --simplify-merges: without a path it has no effect on the output (see _getLogArgs)
    const result: string = await this._exec(['log', '--format=%h', '--date-order', branch, '--'], repo.root);
    return result.split(/\r?\n/g);
  }

  private async _scanFolder(folder: string, includeSubFolders?: boolean): Promise<number> {
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch (err) {
      // unreadable folder (permissions, vanished): nothing to scan there
      Tracer.verbose(`_scanFolder: cannot read ${folder}: ${err}`);
      return 0;
    }
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
    try {
      return (await this._execBuffer(args, cwd, input)).toString('utf8');
    } catch (err) {
      if (throwOnError) {
        throw err;
      }
      return '';
    }
  }

  // Runs git and resolves to its raw output, rejecting with its error output when it fails.
  private async _execBuffer(args: string[], cwd: string, input?: string | Uint8Array): Promise<Buffer> {
    const start = Date.now();
    const cmd = this._gitPath;

    try {
      const result = await new Promise<Buffer>((resolve, reject) => {
        const childProcess = spawn(cmd, args, { cwd });
        // collect the raw chunks and decode once: repeated string concatenation of a large
        // output (e.g. a long log) is much slower
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        childProcess.stdout.on('data', (chunk: Buffer) => {
          stdout.push(chunk);
        });
        childProcess.stderr.on('data', (chunk: Buffer) => {
          stderr.push(chunk);
        });
        childProcess.on('error', reject).on('close', code => {
          if (code === 0) {
            resolve(Buffer.concat(stdout));
          } else {
            reject(Buffer.concat(stderr).toString('utf8'));
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
      throw err;
    }
  }
}
