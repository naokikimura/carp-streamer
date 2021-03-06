import assert from 'assert';
import async from 'async';
import * as box from 'box-node-sdk';
import BoxClient from 'box-node-sdk/lib/box-client';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import LRUCache from 'lru-cache';
import os from 'os';
import path from 'path';
import util from 'util';
import BoxFinder, { CacheConfig } from './box-finder';

// tslint:disable-next-line: no-var-requires
const { name: packageName } = require('../package.json');
const debug = util.debuglog(`${packageName}:app`);

const readdirAsync = fs.promises.readdir;
const statAsync = fs.promises.stat;

export enum SyncEventType {
  ENTER = 'enter',
  ENTERED = 'entered',
  SYNCHRONIZE = 'synchronize',
}

export class Synchronizer extends EventEmitter {
  public static async create(clients: BoxClient[], destination = '0', cacheConfig: CacheConfig = {}, temporaryDirectory = os.tmpdir(), concurrency = 0) {
    assert.notEqual(clients.length, 0);
    const cache = BoxFinder.createCache(cacheConfig.options || {});
    const finders = await Promise.all(clients.map(client =>
      BoxFinder.create(client, destination, cache, cacheConfig.disableCachedResponsesValidation)));
    return new Synchronizer(finders, cache, temporaryDirectory, concurrency);
  }

  private static BOX_FINDER_CACHE_FILE_NAME = 'box-finder.cache.json';
  private boxFinderCacheFile: string;
  private q: async.AsyncQueue<Task>;

  private constructor(private finders: BoxFinder[], private cache: LRUCache<string, box.Item[]>, temporaryDirectory: string, concurrency: number) {
    super();
    this.boxFinderCacheFile = path.join(temporaryDirectory, Synchronizer.BOX_FINDER_CACHE_FILE_NAME);
    this.q = async.queue<Task, SyncResult, Error>(worker, concurrency);
  }

  public async begin() {
    try {
      const file = this.boxFinderCacheFile;
      debug('Load the cache from %s', file);
      const buffer = await fs.promises.readFile(file);
      const entries = JSON.parse(buffer.toString('UTF-8'));
      debug('Loading %s entries into the cache.', entries.length);
      await this.cache.load(entries);
      debug('Loaded %s entries into the cache.', this.cache.keys().length);
    } catch (error) {
      debug('Warning! The BoxFinder cache could not be loaded. (%s)', error);
    }
  }

  public async end() {
    try {
      const file = this.boxFinderCacheFile;
      debug('Save the cache to %s', file);
      const entries = this.cache.dump();
      debug('Saving %s entries from the cache.', entries.length);
      const json = JSON.stringify(entries, null, 0);
      await fs.promises.writeFile(file, json, { encoding: 'UTF-8' });
    } catch (error) {
      debug('Warning! The BoxFinder cache could not be saved. (%s)', error);
    }
  }

  public async synchronize(source: string, excludes: string[] = [], pretend = false) {
    const chooseFinder = () => this.finders[Math.floor(Math.random() * Math.floor(this.finders.length))];
    const callback: async.AsyncResultCallback<SyncResult> = (error, result = { status: SyncResultStatus.UNKNOWN }) => {
      this.emit(SyncEventType.SYNCHRONIZE, error, result.absolutePath, result.status);
    };
    const stats = await statAsync(source);
    if (!stats.isDirectory()) {
      const { dir, base } = path.parse(source);
      const entry = { path: source, dirent: createDirentFromStats(stats, base) };
      this.emit(SyncEventType.ENTER, source);
      this.q.push({ entry, rootPath: dir, finder: chooseFinder(), pretend, excludes }, callback);
      this.emit(SyncEventType.ENTERED, 1);
      return this.q.drain();
    }
    let count = 0;
    for await (const entry of listDirectoryEntriesRecursively(source)) {
      this.emit(SyncEventType.ENTER, entry.path);
      this.q.push({ entry, rootPath: source, finder: chooseFinder(), pretend, excludes }, callback);
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
        await new Promise<box.Items<box.File>>((resolve, reject) => {
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
          await new Promise<box.Items<box.File>>((resolve, reject) => {
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
