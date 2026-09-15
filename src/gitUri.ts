import * as vs from 'vscode';

// Uris of the files of a repository at a revision, served by GitFileSystemProvider, e.g.
// githd-git:/src/utils.ts?{"repo":"/work/githd/","ref":"HEAD~"}
// The path is relative to the repository root, so the breadcrumbs of an editor list the folders of
// the repository rather than those of the disk. The repository root and the revision are kept in
// the query, which vscode preserves when it derives the uris of the parent folders and of the
// sibling files while browsing the breadcrumbs.
export const GitRevisionScheme = 'githd-git';

export interface GitRevisionLocation {
  // the repository root (see GitRepo.root)
  root: string;
  ref: string;
  // path relative to the repository root, '' for the root itself
  relativePath: string;
}

export function toGitRevisionUri(root: string, relativePath: string, ref: string): vs.Uri {
  return vs.Uri.from({
    scheme: GitRevisionScheme,
    path: '/' + relativePath,
    query: JSON.stringify({ repo: root, ref })
  });
}

export function fromGitRevisionUri(uri: vs.Uri): GitRevisionLocation | undefined {
  if (uri.scheme !== GitRevisionScheme) {
    return;
  }
  try {
    const { repo, ref } = JSON.parse(uri.query);
    if (typeof repo !== 'string' || typeof ref !== 'string') {
      return;
    }
    return { root: repo, ref, relativePath: uri.path.replace(/^\/+|\/+$/g, '') };
  } catch {
    return;
  }
}
