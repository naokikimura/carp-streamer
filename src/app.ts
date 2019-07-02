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

const debug = util.debuglog('carp-streamer:app');

export class File {

  constructor(private root: string, readonly relativePath: string, private dirent: fs.Dirent | undefined, private remoteRoot: BoxSDK.Folder, private remoteFile: BoxSDK.MiniFile | undefined) {
  }

  get absolutePath() {
    return path.resolve(this.root, this.relativePath);
  }

  synchronize(client: BoxSDK.BoxClient, pretend: boolean = false) {
    return new Promise<ResultStatus>((resolve, reject) => {
      if (!this.dirent) {
        // client.files.getReadStream()
        resolve(ResultStatus.DOWNLOADED);
      } else if (!this.remoteFile) {
        Promise.resolve().then(async () => {
          if (pretend) return;

          const { dir, base } = path.parse(this.relativePath);
          try {
            const folder = await createRemoteFolderUnlessItExists(dir, this.remoteRoot, client);
            debug('Uploading `%s`...', this.relativePath);
            return client.files.uploadFile(folder.id, base, this.createReadStream());
          } catch (error) {
            debug("Failed to create '%s' folder.", dir);
            throw error;
          }
        }).then(() => resolve(ResultStatus.UPLOADED)).catch(reject);
      } else {
        this.digest().then(sha1 => {
          if (sha1 === this.remoteFile!.sha1) {
            resolve(ResultStatus.SYNCHRONIZED);
          } else {
            Promise.resolve().then(async () => {
              if (pretend) return;

              debug('Upgrading `%s`...', this.relativePath);
              return client.files.uploadNewFileVersion(this.remoteFile!.id, this.createReadStream());
            }).then(() => resolve(ResultStatus.UPGRADED)).catch(reject);
          }
        });
      }
    });
  }

  private digest() {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = this.createReadStream();
      stream.on('data', chunk => hash.update(chunk));
      stream.on('close', () => resolve(hash.digest('hex')));
    });
  }

  private createReadStream() {
    return fs.createReadStream(this.absolutePath)
  }
}

const isMiniFile = (item: BoxSDK.Item): item is BoxSDK.MiniFile => item.type === 'file';

export async function findRemoteFileByPath(relativePath: string, rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.File | undefined> {
  const { dir, base } = path.parse(relativePath);
  const dirs = dir === '' ? [] : dir.split(path.sep);
  return await _findRemoteFileByPath(dirs, base, rootFolder, client);
}

async function _findRemoteFileByPath(folderPath: string[], filename: string, rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.MiniFile | undefined> {
  const folder = await findRemoteFolderByPath(folderPath, rootFolder, client);
  return !folder ? folder : await findRemoteFileByName(filename, client, folder.id);
}

const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

export async function findRemoteFolderByPath(folderPath: string[], rootFolder: BoxSDK.MiniFolder | undefined, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder | undefined> {
  if (folderPath.length === 0 || rootFolder === undefined) {
    return rootFolder === undefined || isFolder(rootFolder) ? rootFolder : await client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath) || '';
  const subFolder = await findRemoteFolderByName(folderName, client, rootFolder.id);
  return await findRemoteFolderByPath(folderPath.slice(1), subFolder, client);
};

const createRemoteFolderByPath = async (folderPath: string[], rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder> => {
  if (folderPath.length === 0) {
    return isFolder(rootFolder) ? rootFolder : await client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath) || '';
  const subFolder = await findRemoteFolderByName(folderName, client, rootFolder.id);
  const folder = subFolder || await createRemoteFolder(client, rootFolder.id, folderName, 3);
  return await createRemoteFolderByPath(folderPath.slice(1), folder, client);
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

async function createRemoteFolder(client: BoxSDK.BoxClient, parentFolderId: string, folderName: string, retryTimes: number): Promise<BoxSDK.Folder> {
  try {
    return await client.folders.create(parentFolderId, folderName);
  } catch (error) {
    debug('%s: %s', error.name, error.message);
    debug(`Failed to create folder '%s' (parent folder id: %s). Retries %d more times.`, folderName, parentFolderId, retryTimes);
    const waitingTime = Math.floor(Math.random() * 100);
    debug(`Waiting time is %d milliseconds.`, waitingTime);
    const startTimestamp = Date.now();
    await sleep(waitingTime);
    const elapsedTime = Date.now() - startTimestamp;
    debug(`Waited for %d milliseconds.`, elapsedTime);
    const folder = await findRemoteFolderByName(folderName, client, parentFolderId);
    if (folder) {
      return await client.folders.get(folder.id);
    } else if (retryTimes > 0) {
      return await createRemoteFolder(client, parentFolderId, folderName, retryTimes - 1);
    } else {
      throw error;
    }
  }
}

export async function createRemoteFolderUnlessItExists(relativePath: string, rootFolder: BoxSDK.MiniFolder, client: BoxSDK.BoxClient): Promise<BoxSDK.Folder> {
  const dirs = !relativePath ? [] : relativePath.split(path.sep);
  const foundFolder = await findRemoteFolderByPath(dirs, rootFolder, client);
  return foundFolder || await createRemoteFolderByPath(dirs, rootFolder, client)
}

const readdir = util.promisify(fs.readdir);
export async function* listDirectoryEntriesRecursively(root: string): AsyncIterableIterator<{path: string, dirent: fs.Dirent}> {
  for(let dirent of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, dirent.name);
    yield ({ path: entryPath, dirent });
    if (dirent.isDirectory()) {
      yield* listDirectoryEntriesRecursively(entryPath);
    }
  }
}
