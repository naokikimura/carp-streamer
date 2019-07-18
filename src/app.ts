import async from 'async';
import * as box from 'box-node-sdk';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import util from 'util';
import { BoxAppConfig, BoxClientBuilder, BoxClientConfig, BoxFinder } from './box';

const debug = util.debuglog('carp-streamer:app');

const readdirAsync = util.promisify(fs.readdir);
const statAsync = util.promisify(fs.stat);

export enum SyncEventType {
  ENTER = 'enter',
  ENTERED = 'entered',
  SYNCHRONIZE = 'synchronize',
}

export class Synchronizer extends EventEmitter {
  private client: box.BoxClient;
  private q: async.AsyncQueue<Task>;

  constructor(appConfig?: BoxAppConfig, accessToken?: string, options?: { asUser: string }, concurrency: number = 0) {
    super();
    const configurator = options && options.asUser
      ? ((client: box.BoxClient) => client.asUser(options.asUser)) : undefined;
    const clientConfig: BoxClientConfig = accessToken
      ? { kind: 'Basic', accessToken, configurator }
      : { kind: 'AppAuth', type: 'enterprise', configurator};
    this.client = new BoxClientBuilder(appConfig, clientConfig).build();
    this.q = async.queue<Task, SyncResult, Error>(worker, concurrency);
  }

  public async synchronize(source: string, destination = '0', excludes: string[] = [], pretend = false) {
    const callback: async.AsyncResultCallback<SyncResult> = (error, result = { status: SyncResultStatus.UNKNOWN }) => {
      this.emit(SyncEventType.SYNCHRONIZE, error, result.absolutePath, result.status);
    };
    const finder = await BoxFinder.create(this.client, destination);
    const stats = await statAsync(source);
    if (!stats.isDirectory()) {
      const { dir, base } = path.parse(source);
      const entry = { path: source, dirent: createDirentFromStats(stats, base) };
      this.emit(SyncEventType.ENTER, source);
      this.q.push({ entry, rootPath: dir, finder, pretend, excludes }, callback);
      this.emit(SyncEventType.ENTERED, 1);
      return this.q.drain();
    }
    let count = 0;
    for await (const entry of listDirectoryEntriesRecursively(source)) {
      this.emit(SyncEventType.ENTER, entry.path);
      this.q.push({ entry, rootPath: source, finder, pretend, excludes }, callback);
      count++;
    }
    this.emit(SyncEventType.ENTERED, count);
    return this.q.drain();
  }
}

interface Task {
  entry: { path: string, dirent?: fs.Dirent, error?: any };
  rootPath: string;
  finder: BoxFinder;
  excludes: string[];
  pretend: boolean;
}

interface SyncResult {
  status: SyncResultStatus;
  absolutePath?: string;
}

async function worker(task: Task, done: async.AsyncResultCallback<SyncResult>) {
  const { entry: { path: absolutePath, dirent, error }, rootPath, finder, pretend, excludes } = task;
  const relativePath = path.relative(rootPath, absolutePath);
  if (error) {
    return done(error, { status: SyncResultStatus.DENIED, absolutePath });
  }
  if (excludes.some(exclude => absolutePath.startsWith(exclude))) {
    return done(null, { status: SyncResultStatus.EXCLUDED, absolutePath });
  }
  try {
    const entry = Entry.create(rootPath, relativePath, finder, dirent);
    const status = await entry.synchronize(pretend);
    done(null, { status, absolutePath });
  } catch (error) {
    done(error, { status: SyncResultStatus.FAILURE, absolutePath });
  }
}

export enum SyncResultStatus {
  UNKNOWN,
  FAILURE,
  DENIED,
  EXCLUDED,
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED,
  CREATED,
}

abstract class Entry {
  get absolutePath() {
    return path.resolve(this.rootPath, this.relativePath);
  }

  public static create(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent) {
    if (!dirent) {
      // TODO:
      throw new Error('Not Implemented Error');
    } else if (dirent.isDirectory()) {
      return new Directory(rootPath, relativePath, finder);
    } else {
      return new File(rootPath, relativePath, finder);
    }
  }

  constructor(private rootPath: string, readonly relativePath: string, protected finder: BoxFinder) { }

  public abstract synchronize(pretend?: boolean): Promise<SyncResultStatus>;
}

class Directory extends Entry {
  public async synchronize(pretend: boolean = false) {
    const remoteFolder = await this.finder.findFolderByPath(this.relativePath);
    if (remoteFolder) {
      return SyncResultStatus.SYNCHRONIZED;
    } else {
      if (!pretend) { await this.finder.createFolderUnlessItExists(this.relativePath); }
      return SyncResultStatus.CREATED;
    }
  }
}

class File extends Entry {
  public async synchronize(pretend: boolean = false) {
    const stats = await statAsync(this.absolutePath);
    const remoteFile = await this.finder.findFileByPath(this.relativePath);
    if (!remoteFile) {
      if (!pretend) {
        const { dir, base } = path.parse(this.relativePath);
        const folder = await this.finder.createFolderUnlessItExists(dir);
        debug('Uploading `%s`...', this.relativePath);
        await new Promise<box.File>((resolve, reject) => {
          const stream = this.createReadStream();
          stream.once('error', reject);
          this.finder.uploadFile(base, stream, stats, folder).then(resolve).catch(reject);
        });
      }
      return SyncResultStatus.UPLOADED;
    } else {
      const sha1 = await this.digest();
      if (sha1 === remoteFile.sha1) {
        return SyncResultStatus.SYNCHRONIZED;
      } else {
        if (!pretend) {
          debug('Upgrading `%s`...', this.relativePath);
          await new Promise<box.File>((resolve, reject) => {
            const stream = this.createReadStream();
            stream.once('error', reject);
            this.finder.uploadNewFileVersion(remoteFile, stream, stats).then(resolve).catch(reject);
          });
        }
        return SyncResultStatus.UPGRADED;
      }
    }
  }

  private digest() {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = this.createReadStream();
      stream.on('data', chunk => hash.update(chunk));
      stream.once('close', () => resolve(hash.digest('hex')));
      stream.once('error', reject);
    });
  }

  private createReadStream() {
    return fs.createReadStream(this.absolutePath);
  }
}

function createDirentFromStats(stats: fs.Stats, name: string): fs.Dirent {
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

interface Entity {
  path: string;
  dirent?: fs.Dirent;
  error?: any;
}

async function* listDirectoryEntriesRecursively(root: string): AsyncIterableIterator<Entity> {
  try {
    for (const dirent of await readdirAsync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, dirent.name);
      yield ({ path: entryPath, dirent });
      if (dirent.isDirectory()) {
        yield* listDirectoryEntriesRecursively(entryPath);
      }
    }
  } catch (error) {
    debug('Oops! %s', error.message);
    yield { path: root, error };
  }
}
