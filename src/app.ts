import BoxSDK from 'box-node-sdk';
import crypto from 'crypto';
import fs from 'fs';
import _ from 'lodash';
import path from 'path';
import util from 'util';

export enum ResultStatus {
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED,
  CREATED
}

const INIT_RETRY_TIMES = 5;

const debug = util.debuglog('carp-streamer:app');

export abstract class Entry {

  get absolutePath() {
    return path.resolve(this.root, this.relativePath);
  }

  public static create(dirent: fs.Dirent | null, root: string, relativePath: string, remoteRoot: BoxSDK.Folder, client: BoxSDK.BoxClient): Promise<Entry> {
    return Entry._create(dirent, root, relativePath, remoteRoot, client, INIT_RETRY_TIMES, 0);
  }

  private static async _create(dirent: fs.Dirent | null, root: string, relativePath: string, remoteRoot: BoxSDK.Folder, client: BoxSDK.BoxClient, retryTimes: number, delay: number): Promise<Entry> {
    const finder = new BoxFinder(client, remoteRoot);
    await sleep(delay);
    try {
      if (!dirent) {
        // TODO:
        throw new Error('Not Implemented Error');
      } else if (dirent.isDirectory()) {
        const remoteFolder = await finder.findFolderByPath(relativePath);
        return new Directory(root, relativePath, dirent, remoteRoot, remoteFolder);
      } else {
        const remoteFile = await finder.findFileByPath(relativePath);
        return new File(root, relativePath, dirent, remoteRoot, remoteFile);
      }
    } catch (error) {
      if (!isBoxAPIResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) { throw error; }

      debug('Retries %d more times.', retryTimes);
      const retryAfter = determineDelayTime(error, retryTimes);
      debug('Tries again in %d milliseconds.', retryAfter);
      return this._create(dirent, root, relativePath, remoteRoot, client, retryTimes - 1, retryAfter);
    }
  }

  constructor(protected root: string, readonly relativePath: string, protected dirent: fs.Dirent | undefined, protected remoteRoot: BoxSDK.Folder) { }

  public synchronize(client: BoxSDK.BoxClient, pretend: boolean = false) {
    return this._synchronize(client, pretend, INIT_RETRY_TIMES, 0);
  }

  protected abstract sync(client: BoxSDK.BoxClient, pretend: boolean): Promise<ResultStatus>;

  private async _synchronize(client: BoxSDK.BoxClient, pretend: boolean, retryTimes: number, delay: number): Promise<ResultStatus> {
    await sleep(delay);
    try {
      return await this.sync(client, pretend);
    } catch (error) {
      if (!isBoxAPIResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) { throw error; }

      debug('Retries %d more times.', retryTimes);
      const retryAfter = determineDelayTime(error, retryTimes);
      debug('Tries again in %d milliseconds.', retryAfter);
      return this._synchronize(client, pretend, retryTimes - 1, retryAfter);
    }
  }
}

function determineDelayTime(error: BoxAPIResponseError, retryTimes: number): number {
  const retryAfter = Number(error.response.headers['retry-after'] || 0);
  return (retryAfter + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
}

class Directory extends Entry {
  constructor(root: string, relativePath: string, dirent: fs.Dirent | undefined, remoteRoot: BoxSDK.Folder, private remoteFolder: BoxSDK.MiniFolder | undefined) {
    super(root, relativePath, dirent, remoteRoot);
  }

  protected async sync(client: BoxSDK.BoxClient, pretend: boolean = false): Promise<ResultStatus> {
    if (this.remoteFolder) {
      return ResultStatus.SYNCHRONIZED;
    } else {
      if (!pretend) { await new BoxFinder(client, this.remoteRoot).createFolderUnlessItExists(this.relativePath); }
      return ResultStatus.CREATED;
    }
  }
}

class File extends Entry {
  constructor(root: string, relativePath: string, dirent: fs.Dirent | undefined, remoteRoot: BoxSDK.Folder, private remoteFile: BoxSDK.MiniFile | undefined) {
    super(root, relativePath, dirent, remoteRoot);
  }

  protected async sync(client: BoxSDK.BoxClient, pretend: boolean = false): Promise<ResultStatus> {
    if (!this.dirent) {
      // client.files.getReadStream()
      return ResultStatus.DOWNLOADED;
    } else if (!this.remoteFile) {
      if (!pretend) {
        const { dir, base } = path.parse(this.relativePath);
        const folder = await new BoxFinder(client, this.remoteRoot).createFolderUnlessItExists(dir);
        debug('Uploading `%s`...', this.relativePath);
        await client.files.uploadFile(folder.id, base, this.createReadStream());
      }
      return ResultStatus.UPLOADED;
    } else {
      const sha1 = await this.digest();
      if (sha1 === this.remoteFile!.sha1) {
        return ResultStatus.SYNCHRONIZED;
      } else {
        if (!pretend) {
          debug('Upgrading `%s`...', this.relativePath);
          await client.files.uploadNewFileVersion(this.remoteFile!.id, this.createReadStream());
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

interface BoxAPIResponseError extends Error {
  statusCode: number;
  response: any;
  request: any;
}

const isBoxAPIResponseError = (error: any): error is BoxAPIResponseError =>
  error.statusCode && error.response && error.request && error instanceof Error;

const isMiniFile = (item: BoxSDK.Item): item is BoxSDK.MiniFile => item.type === 'file';

const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

function sleep(delay: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay));
}

class BoxFinder {

  public static async create(client: BoxSDK.BoxClient, folderId = '0') {
    const folder = await client.folders.get(folderId);
    return new BoxFinder(client, folder);
  }

  private static async createFolderByPath(folderPath: string[], finder: BoxFinder): Promise<BoxSDK.Folder> {
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.client.folders.get(finder.current.id);
    }
    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    const folder = subFolder || await finder.createFolder(folderName);
    return this.createFolderByPath(folderPath.slice(1), finder.new(folder));
  }

  private static async _findFolderByPath(folderPath: string[], finder?: BoxFinder): Promise<BoxSDK.Folder | undefined> {
    if (finder === undefined) { return undefined; }
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.client.folders.get(finder.current.id);
    }

    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    return BoxFinder._findFolderByPath(folderPath.slice(1), subFolder && finder.new(subFolder));
  }

  constructor(private client: BoxSDK.BoxClient, private current: BoxSDK.MiniFolder) {
  }

  public async createFolderUnlessItExists(relativePath: string): Promise<BoxSDK.Folder> {
    const dirs = !relativePath ? [] : relativePath.split(path.sep);
    const foundFolder = await BoxFinder._findFolderByPath(dirs, this);
    return foundFolder || await BoxFinder.createFolderByPath(dirs, this);
  }

  public async findFileByPath(relativePath: string): Promise<BoxSDK.File | undefined> {
    const { dir, base } = path.parse(relativePath);
    const dirs = dir === '' ? [] : dir.split(path.sep);
    const folder = await BoxFinder._findFolderByPath(dirs, this);
    return folder && await this.new(folder).findFileByName(base);
  }

  public findFolderByPath(relativePath: string): Promise<BoxSDK.Folder | undefined> {
    const { dir, base } = path.parse(relativePath);
    const dirs = (dir === '' ? [] : dir.split(path.sep)).concat(base);
    return BoxFinder._findFolderByPath(dirs, this);
  }

  private new(folder: BoxSDK.MiniFolder) {
    return new BoxFinder(this.client, folder);
  }

  private async createFolder(folderName: string, retryTimes = INIT_RETRY_TIMES, delay = 0): Promise<BoxSDK.Folder> {
    const parentFolderId = this.current.id;
    await sleep(delay);
    try {
      return await this.client.folders.create(parentFolderId, folderName);
    } catch (error) {
      debug(`Failed to create folder '%s' (parent folder id: %s).`, folderName, parentFolderId);
      if (!isBoxAPIResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 409 && retryTimes > 0)) { throw error; }

      const folder = await this.findFolderByName(folderName);
      if (folder) {
        return this.client.folders.get(folder.id);
      } else {
        const retryAfter = (Math.floor(Math.random() * 100) * (1 / retryTimes)) * 1000;
        debug(`Waiting time is %d milliseconds.`, retryAfter);
        return this.createFolder(folderName, retryTimes - 1, retryAfter);
      }
    }
  }

  private findFileByName(fileName: string): Promise<BoxSDK.MiniFile | undefined> {
    return this.findItemByName<BoxSDK.MiniFile>(fileName, isMiniFile);
  }

  private findFolderByName(folderName: string): Promise<BoxSDK.MiniFolder | undefined> {
    return this.findItemByName<BoxSDK.MiniFolder>(folderName, isMiniFolder);
  }

  private async findItemByName<T extends BoxSDK.Item>(itemName: string, isItem: (item: BoxSDK.Item) => item is T): Promise<T | undefined> {
    for await (const item of this.fetchFolderItems()) {
      if (isItem(item) && item.name.normalize() === itemName.normalize()) { return item; }
    }
  }

  private async * fetchFolderItems(marker?: string): AsyncIterableIterator<BoxSDK.Item> {
    const parentFolderId = this.current.id;
    const items = await this.client.folders.getItems(parentFolderId, { usemarker: true, marker });
    yield* items.entries;
    if (items.next_marker) { yield* this.fetchFolderItems(items.next_marker); }
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
export async function* listDirectoryEntriesRecursively(root: string): AsyncIterableIterator<{ path: string, dirent: fs.Dirent | null, error: any }> {
  try {
    for (const dirent of await readdirAsync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, dirent.name);
      yield ({ path: entryPath, dirent, error: null });
      if (dirent.isDirectory()) {
        yield* listDirectoryEntriesRecursively(entryPath);
      }
    }
  } catch (error) {
    yield { path: root, dirent: null, error };
  }
}
