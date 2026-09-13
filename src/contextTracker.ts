import * as vs from 'vscode';

const maxTrackedCount = 100;

// Structural equality of the tracked contexts: plain objects of primitives, Dates and Uris.
// Uris are compared by value, whichever of their lazily computed fields (fsPath) has been read.
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof vs.Uri && b instanceof vs.Uri) {
    return a.toString() === b.toString();
  }
  return isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b) && haveEqualEntries(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function haveEqualEntries(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && isEqual(a[key], b[key]))
  );
}

export class ContextTracker<T> {
  private _tracker: T[] = [];
  private _nextIndex: number = 0;

  constructor(
    private _goBackFlag: string,
    private _goForwardFlag: string
  ) {}

  setContext(context: T) {
    if (!context || isEqual(this.current, context)) {
      return;
    }

    vs.commands.executeCommand('setContext', this._goForwardFlag, false);
    if (this._nextIndex == 1) {
      // we don't want the current one to be an empty
      vs.commands.executeCommand('setContext', this._goBackFlag, true);
    }

    if (this._nextIndex == maxTrackedCount) {
      this._tracker = this._tracker.slice(1, this._nextIndex);
    } else {
      this._nextIndex++;
      this._tracker = this._tracker.slice(0, this._nextIndex);
    }
    this._tracker[this._nextIndex - 1] = context;
  }

  get current(): T | undefined {
    return this._nextIndex > 0 ? this._tracker[this._nextIndex - 1] : undefined;
  }

  goBack(): boolean {
    if (this._nextIndex <= 1) {
      return false;
    }

    if (this._nextIndex == this._tracker.length) {
      vs.commands.executeCommand('setContext', this._goForwardFlag, true);
    }

    this._nextIndex--;
    if (this._nextIndex <= 1) {
      vs.commands.executeCommand('setContext', this._goBackFlag, false);
    }

    return true;
  }

  goForward(): boolean {
    if (this._nextIndex == this._tracker.length) {
      return false;
    }

    if (this._nextIndex <= 1) {
      vs.commands.executeCommand('setContext', this._goBackFlag, true);
    }

    this._nextIndex++;
    if (this._nextIndex == this._tracker.length) {
      vs.commands.executeCommand('setContext', this._goForwardFlag, false);
    }
    return true;
  }

  clear() {
    this._nextIndex = 0;
    this._tracker = [];
    vs.commands.executeCommand('setContext', this._goBackFlag, false);
    vs.commands.executeCommand('setContext', this._goForwardFlag, false);
  }
}
