import BoxSDK, * as box from 'box-node-sdk';
import { ReadStream, Stats } from 'fs';
import _ from 'lodash';
import path from 'path';
import util from 'util';
import { INIT_RETRY_TIMES } from './config';
import { sleep } from './util';

const debug = util.debuglog('carp-streamer:box');

export interface BoxAppConfig {
  boxAppSettings: {
    clientID: string;
    clientSecret: string;
    appAuth?: {
      publicKeyID: string;
      privateKey: string;
      passphrase: string;
    }
  };
  webhooks?: {
    primaryKey: string;
    secondaryKey: string;
  };
  enterpriseID?: string;
}

export interface BoxClientConfig {
  kind: 'Basic' | 'AppAuth' | 'Anonymous';
  configurator?: (client: box.BoxClient) => void;
}

export interface BoxBasicClientConfig extends BoxClientConfig {
  kind: 'Basic';
  accessToken: string;
}

export interface BoxAppAuthClientConfig extends BoxClientConfig {
  kind: 'AppAuth';
  type: 'enterprise' | 'user';
  id?: string;
}

export interface BoxAnonymousClientConfig extends BoxClientConfig {
  kind: 'Anonymous';
}

const isBoxBasicClientConfig = (config: BoxClientConfig): config is BoxBasicClientConfig => config.kind === 'Basic';
const isBoxAppAuthClientConfig = (config: BoxClientConfig): config is BoxAppAuthClientConfig => config.kind === 'AppAuth';
const isBoxAnonymousClientConfig = (config: BoxClientConfig): config is BoxAnonymousClientConfig => config.kind === 'Anonymous';

export class BoxClientBuilder {
  private sdk: BoxSDK;
  private config: BoxClientConfig;

  constructor(appConfig: BoxAppConfig = { boxAppSettings: { clientID: '', clientSecret: '' } }, clientConfig: BoxBasicClientConfig | BoxAppAuthClientConfig | BoxAnonymousClientConfig = { kind: 'Anonymous' }) {
    this.sdk = BoxSDK.getPreconfiguredInstance(appConfig);
    this.config = clientConfig;
  }

  public build() {
    let client;
    if (isBoxBasicClientConfig(this.config)) {
      client = this.sdk.getBasicClient(this.config.accessToken);
    } else if (isBoxAppAuthClientConfig(this.config)) {
      client = this.sdk.getAppAuthClient(this.config.type, this.config.id);
    } else {
      client = this.sdk.getAnonymousClient();
    }
    if (this.config.configurator) {
      this.config.configurator(client);
    }
    return client;
  }
}

const CHUNKED_UPLOAD_MINIMUM = 20_000_000;

function findConflictItem(error: box.ResponseError) {
  if (error.statusCode === 409) {
    return _.first(error.response.body.context_info && error.response.body.context_info.conflicts);
  }
}

function isResponseError(error: any): error is box.ResponseError {
  return error.statusCode && error.response && error.request && error instanceof Error;
}

const isMiniFile = (item: box.Item): item is box.MiniFile => item.type === 'file';
const isFolder = (item: box.MiniFolder): item is box.Folder => (item as box.Folder).size !== undefined;
const isMiniFolder = (item: box.Item): item is box.MiniFolder => item.type === 'folder';

export class BoxFinder {
  public static async create(client: box.BoxClient, folderId = '0') {
    const folders = proxyToTrapTooManyRequests(client.folders);
    const current = await folders.get(folderId);
    return BoxFinder.new(client, current);
  }

  private static new(client: box.BoxClient, folder: box.MiniFolder) {
    return new BoxFinder(client, folder);
  }

  private static async createFolderByPath(folderPath: string[], finder: BoxFinder): Promise<box.Folder> {
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.folders.get(finder.current.id);
    }
    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    const folder = subFolder || await finder.createFolder(folderName);
    return this.createFolderByPath(folderPath.slice(1), finder.new(folder));
  }

  private static async _findFolderByPath(folderPath: string[], finder?: BoxFinder): Promise<box.Folder | undefined> {
    if (finder === undefined) {
      return undefined;
    }
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.folders.get(finder.current.id);
    }
    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    return BoxFinder._findFolderByPath(folderPath.slice(1), subFolder && finder.new(subFolder));
  }

  private files: box.Files;
  private folders: box.Folders;

  private constructor(private client: box.BoxClient, readonly current: box.MiniFolder) {
    this.files = proxyToTrapTooManyRequests(client.files);
    this.folders = proxyToTrapTooManyRequests(client.folders);
  }

  public async createFolderUnlessItExists(relativePath: string) {
    const dirs = !relativePath ? [] : relativePath.split(path.sep);
    const foundFolder = await BoxFinder._findFolderByPath(dirs, this);
    return foundFolder || BoxFinder.createFolderByPath(dirs, this);
  }

  public async findFileByPath(relativePath: string) {
    const { dir, base } = path.parse(relativePath);
    const dirs = dir === '' ? [] : dir.split(path.sep);
    const folder = await BoxFinder._findFolderByPath(dirs, this);
    return folder && this.new(folder).findFileByName(base);
  }

  public findFolderByPath(relativePath: string) {
    const { dir, base } = path.parse(relativePath);
    const dirs = (dir === '' ? [] : dir.split(path.sep)).concat(base);
    return BoxFinder._findFolderByPath(dirs, this);
  }

  public async uploadFile(name: string, content: string | Buffer | ReadStream, stats?: Stats, folder?: box.MiniFolder) {
    const folderId = (folder || this.current).id;
    const options = {
      content_created_at: stats && toRFC3339String(stats.ctime),
      content_modified_at: stats && toRFC3339String(stats.mtime),
    };
    try {
      const result = await this.files.preflightUploadFile(folderId, { name, size: stats && stats.size });
      debug('preflight Upload File: %o', result);
    } catch (error) {
      debug('preflight error: %s', error.message);
      if (!isResponseError(error) || error.statusCode !== 409) { throw error; }

      const item = findConflictItem(error);
      if (item && isMiniFile(item)) {
        debug('Found existing folder with that name: %s', item.name);
        const finder = (folder ? this.new(folder) : this);
        return finder.uploadNewFileVersion(item, content, stats);
      } else {
        throw error;
      }
    }
    debug('uploading %s...', name);
    if (stats && (stats.size >= CHUNKED_UPLOAD_MINIMUM)) {
      const chunkedUploader = await this.files.getChunkedUploader(folderId, stats.size, name, content, { fileAttributes: options });
      chunkedUploader
        .on('chunkUploaded', (data: box.UploadPart) => {
          debug('chunk uploaded: %s', data.part.size);
        })
        .on('uploadComplete', (uploadFile: box.File) => {
          debug('upload complete: %s', uploadFile.name);
        });
      return chunkedUploader.start();
    } else {
      return this.files.uploadFile(folderId, name, content, options);
    }
  }

  public async uploadNewFileVersion(file: box.MiniFile, content: string | Buffer | ReadStream, stats?: Stats) {
    const options = {
      content_modified_at: stats && toRFC3339String(stats.mtime),
    };
    const fileData = { name: file.name, size: stats && stats.size };
    const result = await this.files.preflightUploadNewFileVersion(file.id, fileData);
    debug('preflight Upload New File Version: %o', result);
    if (stats && (stats.size >= CHUNKED_UPLOAD_MINIMUM)) {
      const chunkedUploader = await this.files.getNewVersionChunkedUploader(file.id, stats.size, content, { fileAttributes: options });
      chunkedUploader
        .on('chunkUploaded', (data: box.UploadPart) => {
          debug('chunk uploaded: %s', data.part.size);
        })
        .on('uploadComplete', (uploadFile: box.File) => {
          debug('upload complete: %s', uploadFile.name);
        });
      return chunkedUploader.start();
    } else {
      return this.files.uploadNewFileVersion(file.id, content, options);
    }
  }

  private new(folder: box.MiniFolder) {
    return BoxFinder.new(this.client, folder);
  }

  private createFolder(folderName: string): Promise<box.Folder> {
    const parentFolderId = this.current.id;
    return makeRetriable(this.folders.create, this.folders, retryIfFolderConflictError)(parentFolderId, folderName);
  }

  private findFileByName(fileName: string) {
    return this.findItemByName<box.MiniFile>(fileName, isMiniFile);
  }

  private findFolderByName(folderName: string) {
    return this.findItemByName<box.MiniFolder>(folderName, isMiniFolder);
  }

  private async findItemByName<T extends box.Item>(itemName: string, isItem: (item: box.Item) => item is T): Promise<T | undefined> {
    for await (const item of this.fetchFolderItems()) {
      if (isItem(item) && item.name.normalize() === itemName.normalize()) {
        return item;
      }
    }
  }

  private async *fetchFolderItems(marker?: string): AsyncIterableIterator<box.Item> {
    const parentFolderId = this.current.id;
    const items = await this.folders.getItems(parentFolderId, { usemarker: true, marker });
    yield* items.entries;
    if (items.next_marker) {
      yield* this.fetchFolderItems(items.next_marker);
    }
  }
}

type asyncFn<T> = (...args: any[]) => Promise<T>;
type RetryCallback<T, U> =
  (error: any, method: asyncFn<T>, that: U, args: any[], retryTimes: number, delay: number) => Promise<T>;

function makeRetriable<T, U>(method: asyncFn<T>, that: U, callback: RetryCallback<T, U>, retryTimes = INIT_RETRY_TIMES, delay = 0): asyncFn<T> {
  return async (...args: any[]): Promise<T> => {
    await sleep(delay);
    try {
      return await Reflect.apply(method, that, args);
    } catch (error) {
      if (retryTimes > 0) {
        return callback(error, method, that, args, retryTimes, delay);
      }
      throw error;
    }
  };
}

function determineDelayTime(retryTimes: number, error?: box.ResponseError): number {
  const retryAfter = Number(error ? error.response.headers['retry-after'] || 0 : 0);
  return (retryAfter + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
}

const retryIfTooManyRequestsError: RetryCallback<any, any> = (error, method, that, args, retryTimes) => {
  if (!isResponseError(error) || error.statusCode !== 429) { throw error; }

  debug('API Response Error: %s', error.message);
  debug('Retries %d more times.', retryTimes);
  const retryAfter = determineDelayTime(retryTimes, error);
  debug('Tries again in %d milliseconds.', retryAfter);
  return makeRetriable(method, that, retryIfTooManyRequestsError, retryTimes - 1, retryAfter)(...args);
};

const retryIfFolderConflictError: RetryCallback<box.Folder, box.Folders> = async (error, method, that, args, retryTimes) => {
  const [parentFolderId, folderName] = args;
  debug(`Failed to create folder '%s' (parent folder id: %s).`, folderName, parentFolderId);
  if (!isResponseError(error) || error.statusCode !== 409) { throw error; }

  debug('API Response Error: %s', error.message);
  const item = findConflictItem(error);
  if (item) {
    debug('Found existing folder with that name: %s', item.name);
    return that.get(item.id);
  } else {
    debug('Retries %d more times.', retryTimes);
    const retryAfter = determineDelayTime(retryTimes, error);
    debug(`Waiting time is %d milliseconds.`, retryAfter);
    return makeRetriable(method, that, retryIfFolderConflictError, retryTimes - 1, retryAfter)(...args);
  }
};

function proxyToTrapTooManyRequests<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (subject: T, propertyKey, receiver) => {
      const property = Reflect.get(subject, propertyKey, receiver);
      if (property instanceof Function) {
        return makeRetriable<any, T>(property, subject, retryIfTooManyRequestsError);
      }
      return property;
    }
  });
}

function toRFC3339String(date: Date) {
  return date.toISOString().replace(/\.(\d{3})Z$/, 'Z');
}
