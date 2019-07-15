import async from 'async';
import * as box from 'box-node-sdk';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import util from 'util';
import { BoxClientBuilder, BoxFinder } from './box';

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

  constructor(appConfig?: { boxAppSettings: any }, accessToken?: string, options?: { asUser: string }, concurrency: number = 0) {
    super();
    this.client = new BoxClientBuilder()
      .setAppConfig(appConfig)
      .setAccessToken(accessToken)
      .setAsUser(options && options.asUser)
      .build();
    this.q = async.queue<Task, SyncResult, Error>(worker, concurrency);
  }

  public async synchronize(source: string, destination = '0', excludes: string[] = [], pretend = false) {
    const self = this;
    const callback: async.AsyncResultCallback<SyncResult> = (error = null, result = { status: SyncResultStatus.UNKNOWN }) => {
      self.emit(SyncEventType.SYNCHRONIZE, error, result.absolutePath, result.status);
    };
    const finder = await BoxFinder.create(this.client, destination);
    const stats = await statAsync(source);
    if (!stats.isDirectory()) {
      const { dir, base } = path.parse(source);
      const entry = { path: source, dirent: createDirentFromStats(stats, base), error: null };
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
    const entry = await Entry.create(rootPath, relativePath, finder, dirent);
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

  public static async create(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent) {
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
  }

  constructor(private rootPath: string, readonly relativePath: string, protected finder: BoxFinder, protected dirent?: fs.Dirent) { }

  public abstract synchronize(pretend?: boolean): Promise<SyncResultStatus>;
}

class Directory extends Entry {
  constructor(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, private remoteFolder?: box.MiniFolder) {
    super(rootPath, relativePath, finder, dirent);
  }

  public async synchronize(pretend: boolean = false) {
    if (this.remoteFolder) {
      return SyncResultStatus.SYNCHRONIZED;
    } else {
      if (!pretend) { await this.finder.createFolderUnlessItExists(this.relativePath); }
      return SyncResultStatus.CREATED;
    }
  }
}

class File extends Entry {
  constructor(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, private remoteFile?: box.MiniFile) {
    super(rootPath, relativePath, finder, dirent);
  }

  public async synchronize(pretend: boolean = false) {
    if (!this.dirent) {
      // client.files.getReadStream()
      return SyncResultStatus.DOWNLOADED;
    }
    const stats = await statAsync(this.absolutePath);
    if (!this.remoteFile) {
      if (!pretend) {
        const { dir, base } = path.parse(this.relativePath);
        const folder = await this.finder.createFolderUnlessItExists(dir);
        debug('Uploading `%s`...', this.relativePath);
        const stream = this.createReadStream();
        return new Promise<SyncResultStatus>(async (resolve, reject) => {
          stream.on('error', reject);
          this.finder.uploadFile(base, stream, stats, folder)
            .then(() => resolve(SyncResultStatus.UPLOADED)).catch(reject);
        });
      }
      return SyncResultStatus.UPLOADED;
    } else {
      const sha1 = await this.digest();
      if (sha1 === this.remoteFile.sha1) {
        return SyncResultStatus.SYNCHRONIZED;
      } else {
        if (!pretend) {
          const remoteFile = this.remoteFile;
          const stream = this.createReadStream();
          debug('Upgrading `%s`...', this.relativePath);
          return new Promise<SyncResultStatus>(async (resolve, reject) => {
            stream.on('error', reject);
            this.finder.uploadNewFileVersion(remoteFile, stream, stats)
              .then(() => resolve(SyncResultStatus.UPGRADED)).catch(reject);
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
      stream.on('close', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private createReadStream() {
    return fs.createReadStream(this.absolutePath);
  }
}

function createDirentFromStats(stats: fs.Stats, name: string): fs.Dirent {
  return new class extends fs.Dirent {
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
      yield ({ path: entryPath, dirent, error: null });
      if (dirent.isDirectory()) {
        yield* listDirectoryEntriesRecursively(entryPath);
      }
    }
  } catch (error) {
    debug('Oops! %s', error.message);
    yield { path: root, dirent: undefined, error };
  }
}
