import BoxSDK from 'box-node-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import util from 'util';
import { BoxFinder, isResponseError, ResponseError } from './box';
import { INIT_RETRY_TIMES } from './config';
import { sleep } from './util';

export enum ResultStatus {
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED,
  CREATED
}

const debug = util.debuglog('carp-streamer:app');

export abstract class Entry {
  get absolutePath() {
    return path.resolve(this.rootPath, this.relativePath);
  }

  public static create(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent) {
    return Entry._create(rootPath, relativePath, finder, dirent, INIT_RETRY_TIMES, 0);
  }

  private static async _create(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, retryTimes = INIT_RETRY_TIMES, delay = 0): Promise<Entry> {
    await sleep(delay);
    try {
      if (!dirent) {
        // TODO:
        throw new Error('Not Implemented Error');
      } else if (dirent.isDirectory()) {
        const remoteFolder = await finder.findFolderByPath(relativePath);
        return new Directory(rootPath, relativePath, finder, dirent, remoteFolder);
      } else {
        const remoteFile = await finder.findFileByPath(relativePath);
        return new File(rootPath, relativePath, finder, dirent, remoteFile);
      }
    } catch (error) {
      if (!isResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) { throw error; }

      debug('Retries %d more times.', retryTimes);
      const retryAfter = determineDelayTime(retryTimes, error);
      debug('Tries again in %d milliseconds.', retryAfter);
      return this._create(rootPath, relativePath, finder, dirent, retryTimes - 1, retryAfter);
    }
  }

  constructor(private rootPath: string, readonly relativePath: string, protected finder: BoxFinder, protected dirent?: fs.Dirent) { }

  public synchronize(pretend: boolean = false) {
    return this._synchronize(pretend);
  }

  protected abstract sync(pretend: boolean): Promise<ResultStatus>;

  private async _synchronize(pretend: boolean, retryTimes = INIT_RETRY_TIMES, delay = 0): Promise<ResultStatus> {
    await sleep(delay);
    try {
      return await this.sync(pretend);
    } catch (error) {
      if (!isResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) { throw error; }

      debug('Retries %d more times.', retryTimes);
      const retryAfter = determineDelayTime(retryTimes, error);
      debug('Tries again in %d milliseconds.', retryAfter);
      return this._synchronize(pretend, retryTimes - 1, retryAfter);
    }
  }
}

function determineDelayTime(retryTimes: number, error?: ResponseError): number {
  const retryAfter = Number(error ? error.response.headers['retry-after'] || 0 : 0);
  return (retryAfter + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
}

class Directory extends Entry {
  constructor(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, private remoteFolder?: BoxSDK.MiniFolder) {
    super(rootPath, relativePath, finder, dirent);
  }

  protected async sync(pretend: boolean = false): Promise<ResultStatus> {
    if (this.remoteFolder) {
      return ResultStatus.SYNCHRONIZED;
    } else {
      if (!pretend) { await this.finder.createFolderUnlessItExists(this.relativePath); }
      return ResultStatus.CREATED;
    }
  }
}

class File extends Entry {
  constructor(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, private remoteFile?: BoxSDK.MiniFile) {
    super(rootPath, relativePath, finder, dirent);
  }

  protected async sync(pretend: boolean = false): Promise<ResultStatus> {
    if (!this.dirent) {
      // client.files.getReadStream()
      return ResultStatus.DOWNLOADED;
    } else if (!this.remoteFile) {
      if (!pretend) {
        const { dir, base } = path.parse(this.relativePath);
        const folder = await this.finder.createFolderUnlessItExists(dir);
        debug('Uploading `%s`...', this.relativePath);
        await this.finder.client.files.uploadFile(folder.id, base, this.createReadStream());
      }
      return ResultStatus.UPLOADED;
    } else {
      const sha1 = await this.digest();
      if (sha1 === this.remoteFile.sha1) {
        return ResultStatus.SYNCHRONIZED;
      } else {
        if (!pretend) {
          debug('Upgrading `%s`...', this.relativePath);
          await this.finder.client.files.uploadNewFileVersion(this.remoteFile.id, this.createReadStream());
        }
        return ResultStatus.UPGRADED;
      }
    }
  }

  private digest() {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = this.createReadStream();
      stream.on('data', chunk => hash.update(chunk));
      stream.on('close', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private createReadStream() {
    return fs.createReadStream(this.absolutePath);
  }
}

export function createDirentFromStats(stats: fs.Stats, name: string): fs.Dirent {
  // tslint:disable-next-line: no-empty-interface
  interface DirentLike extends fs.Dirent { }
  return new class implements DirentLike {
    get name() { return name; }
    public isBlockDevice() { return stats.isBlockDevice(); }
    public isCharacterDevice() { return stats.isCharacterDevice(); }
    public isDirectory() { return stats.isDirectory(); }
    public isFIFO() { return stats.isFIFO(); }
    public isFile() { return stats.isFile(); }
    public isSocket() { return stats.isSocket(); }
    public isSymbolicLink() { return stats.isSymbolicLink(); }
  }();
}

const readdirAsync = util.promisify(fs.readdir);
export async function* listDirectoryEntriesRecursively(root: string): AsyncIterableIterator<{ path: string, dirent?: fs.Dirent, error?: any }> {
  try {
    for (const dirent of await readdirAsync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, dirent.name);
      yield ({ path: entryPath, dirent, error: null });
      if (dirent.isDirectory()) {
        yield* listDirectoryEntriesRecursively(entryPath);
      }
    }
  } catch (error) {
    yield { path: root, dirent: undefined, error };
  }
}
