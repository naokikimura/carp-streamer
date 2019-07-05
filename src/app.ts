import BoxSDK from 'box-node-sdk';
import _ from 'lodash';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import util from 'util';

export enum ResultStatus {
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED
}

const INIT_RETRY_TIMES = 5;

const debug = util.debuglog('carp-streamer:app');

export abstract class Entry {
  constructor(protected root: string, readonly relativePath: string, protected dirent: fs.Dirent | undefined, protected remoteRoot: BoxSDK.Folder) {
  }

  get absolutePath() {
    return path.resolve(this.root, this.relativePath);
  }

  synchronize(client: BoxSDK.BoxClient, pretend: boolean = false) {
    return this._synchronize(client, pretend, INIT_RETRY_TIMES, 0);
  }

  private async _synchronize(client: BoxSDK.BoxClient, pretend: boolean, retryTimes: number, delay: number): Promise<ResultStatus> {
    await sleep(delay);
    try {
      return await this.sync(client, pretend);
    } catch (error) {
      if (!isBoxAPIResponseError(error)) throw error;
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) throw error;

      debug('Retries %d more times.', retryTimes);
      const retryAfter = (Number(error.response.headers['retry-after'] || 0) + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
      debug('Tries again in %d milliseconds.', retryAfter);
      return this._synchronize(client, pretend, retryTimes - 1, retryAfter);
    }
  }

  static create(dirent: fs.Dirent, root: string, relativePath: string, remoteRoot: BoxSDK.Folder, client: BoxSDK.BoxClient): Promise<Entry> {
    return Entry._create(dirent, root, relativePath, remoteRoot, client, INIT_RETRY_TIMES, 0);
  }

  private static async _create(dirent: fs.Dirent, root: string, relativePath: string, remoteRoot: BoxSDK.Folder, client: BoxSDK.BoxClient, retryTimes: number, delay: number): Promise<Entry> {
    await sleep(delay);
    try {
      if (!dirent) {
        // TODO:
        throw new Error('Not Implemented Error');
      } else if (dirent.isDirectory()) {
        return new Directory(root, relativePath, dirent, remoteRoot, await findRemoteFolderByPath(relativePath, remoteRoot, client));
      } else {
        return new File(root, relativePath, dirent, remoteRoot, await findRemoteFileByPath(relativePath, remoteRoot, client));
      }
    } catch (error) {
      if (!isBoxAPIResponseError(error)) throw error;
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) throw error;

      debug('Retries %d more times.', retryTimes);
      const retryAfter = (Number(error.response.headers['retry-after'] || 0) + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
      debug('Tries again in %d milliseconds.', retryAfter);
      return this._create(dirent, root, relativePath, remoteRoot, client, retryTimes - 1, retryAfter);
    }
  }

  protected abstract sync(client: BoxSDK.BoxClient, pretend: boolean): Promise<ResultStatus>;
}

export class Directory extends Entry {
  constructor(root: string, relativePath: string, dirent: fs.Dirent | undefined, remoteRoot: BoxSDK.Folder, private remoteFile: BoxSDK.MiniFolder | undefined) {
    super(root, relativePath, dirent, remoteRoot);
  }

  protected async sync(client: BoxSDK.BoxClient, pretend: boolean = false): Promise<ResultStatus> {
    if (!pretend) await createRemoteFolderUnlessItExists(this.relativePath, this.remoteRoot, client);
    return ResultStatus.SYNCHRONIZED;
  }
}

export class File extends Entry {
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
        const folder = await createRemoteFolderUnlessItExists(dir, this.remoteRoot, client);
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
    return fs.createReadStream(this.absolutePath)
  }
}

interface BoxAPIResponseError extends Error {
  statusCode: number;
  response: any;
  request: any;
}
const isBoxAPIResponseError = (error: any): error is BoxAPIResponseError => error.statusCode && error.response && error.request && error instanceof Error;

const isMiniFile = (item: BoxSDK.Item): item is BoxSDK.MiniFile => item.type === 'file';

function findRemoteFileByPath(relativePath: string, rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.File | undefined> {
  const { dir, base } = path.parse(relativePath);
  const dirs = dir === '' ? [] : dir.split(path.sep);
  return _findRemoteFileByPath(dirs, base, rootFolder, client);
}

async function _findRemoteFileByPath(folderPath: string[], filename: string, rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.MiniFile | undefined> {
  const folder = await _findRemoteFolderByPath(folderPath, rootFolder, client);
  return !folder ? folder : await findRemoteFileByName(filename, client, folder.id);
}

const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

function findRemoteFolderByPath(relativePath: string, rootFolder: BoxSDK.MiniFolder | undefined, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder | undefined> {
  const { dir, base } = path.parse(relativePath);
  const dirs = dir === '' ? [] : dir.split(path.sep);
  return _findRemoteFolderByPath(dirs, rootFolder, client);
}

async function _findRemoteFolderByPath(folderPath: string[], rootFolder: BoxSDK.MiniFolder | undefined, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder | undefined> {
  if (folderPath.length === 0 || rootFolder === undefined) {
    return rootFolder === undefined || isFolder(rootFolder) ? rootFolder : await client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath) || '';
  const subFolder = await findRemoteFolderByName(folderName, client, rootFolder.id);
  return _findRemoteFolderByPath(folderPath.slice(1), subFolder, client);
};

const createRemoteFolderByPath = async (folderPath: string[], rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder> => {
  if (folderPath.length === 0) {
    return isFolder(rootFolder) ? rootFolder : await client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath) || '';
  const subFolder = await findRemoteFolderByName(folderName, client, rootFolder.id);
  const folder = subFolder || await createRemoteFolder(client, rootFolder.id, folderName, INIT_RETRY_TIMES, 0);
  return createRemoteFolderByPath(folderPath.slice(1), folder, client);
};

function sleep(delay: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay));
}

async function* fetchRemoteFolderItems(client: BoxSDK.BoxClient, parentFolderId: string, marker?: string): AsyncIterableIterator<BoxSDK.Item> {
  const items = await client.folders.getItems(parentFolderId, { usemarker: true, marker });
  yield* items.entries;
  if (items.next_marker) yield* fetchRemoteFolderItems(client, parentFolderId, items.next_marker);
}

async function findRemoteFolderByName(folderName: string, client: BoxSDK.BoxClient, parentFolderId: string): Promise<BoxSDK.MiniFolder | undefined> {
  for await (let item of fetchRemoteFolderItems(client, parentFolderId)) {
    if (isMiniFolder(item) && item.name == folderName) return item;
  }
}

async function findRemoteFileByName(fileName: string, client: BoxSDK.BoxClient, parentFolderId: string): Promise<BoxSDK.MiniFile | undefined> {
  for await (let item of fetchRemoteFolderItems(client, parentFolderId)) {
    if (isMiniFile(item) && item.name.normalize() == fileName.normalize()) return item;
  }
}

async function createRemoteFolder(client: BoxSDK.BoxClient, parentFolderId: string, folderName: string, retryTimes: number, delay: number): Promise<BoxSDK.Folder> {
  await sleep(delay);
  try {
    return await client.folders.create(parentFolderId, folderName);
  } catch (error) {
    debug(`Failed to create folder '%s' (parent folder id: %s).`, folderName, parentFolderId);
    if (!isBoxAPIResponseError(error)) throw error;
    debug('API Response Error: %s', error.message);
    if (!(error.statusCode === 409 && retryTimes > 0)) throw error;

    const folder = await findRemoteFolderByName(folderName, client, parentFolderId);
    if (folder) {
      return client.folders.get(folder.id);
    } else {
      const retryAfter = (Math.floor(Math.random() * 100) * (1 / retryTimes)) * 1000;
      debug(`Waiting time is %d milliseconds.`, retryAfter);
      return createRemoteFolder(client, parentFolderId, folderName, retryTimes - 1, retryAfter);
    }
  }
}

async function createRemoteFolderUnlessItExists(relativePath: string, rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder> {
  const dirs = !relativePath ? [] : relativePath.split(path.sep);
  const foundFolder = await _findRemoteFolderByPath(dirs, rootFolder, client);
  return foundFolder || await createRemoteFolderByPath(dirs, rootFolder, client)
}

const readdir = util.promisify(fs.readdir);
export async function* listDirectoryEntriesRecursively(root: string): AsyncIterableIterator<{path: string, dirent: fs.Dirent | null, error:any}> {
  try {
    for(let dirent of await readdir(root, { withFileTypes: true })) {
      const entryPath = path.join(root, dirent.name);
      yield ({ path: entryPath, dirent, error: null });
      if (dirent.isDirectory()) {
        yield* listDirectoryEntriesRecursively(entryPath);
      }
    }
  } catch (error) {
    yield { path: root, dirent: null, error};
  }
}
