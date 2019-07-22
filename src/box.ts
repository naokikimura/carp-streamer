import BoxSDK, * as box from 'box-node-sdk';
import { ReadStream, Stats } from 'fs';
import _ from 'lodash';
import LRUCache from 'lru-cache';
import sizeof from 'object-sizeof';
import path from 'path';
import url from 'url';
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

interface BoxClientConfiguration {
  kind: 'Basic' | 'Persistent' | 'AppAuth' | 'Anonymous';
  configurator?: (client: box.BoxClient) => void;
}

interface BoxBasicClientConfig extends BoxClientConfiguration {
  kind: 'Basic';
  accessToken: string;
}

interface BoxPersistentClientConfig extends BoxClientConfiguration {
  kind: 'Persistent';
  tokenInfo: box.TokenInfo;
}

interface BoxAppAuthClientConfig extends BoxClientConfiguration {
  kind: 'AppAuth';
  type: 'enterprise' | 'user';
  id?: string;
}

interface BoxAnonymousClientConfig extends BoxClientConfiguration {
  kind: 'Anonymous';
}

export type BoxClientConfig = BoxBasicClientConfig | BoxPersistentClientConfig | BoxAppAuthClientConfig | BoxAnonymousClientConfig;

const isBoxBasicClientConfig = (config: BoxClientConfig): config is BoxBasicClientConfig => config.kind === 'Basic';
const isBoxPersistentClientConfig = (config: BoxClientConfig): config is BoxPersistentClientConfig => config.kind === 'Persistent';
const isBoxAppAuthClientConfig = (config: BoxClientConfig): config is BoxAppAuthClientConfig => config.kind === 'AppAuth';
const isBoxAnonymousClientConfig = (config: BoxClientConfig): config is BoxAnonymousClientConfig => config.kind === 'Anonymous';

export class BoxClientBuilder {
  private static build(sdk: BoxSDK, config: BoxClientConfig) {
    const client = (() => {
      if (isBoxBasicClientConfig(config)) {
        return sdk.getBasicClient(config.accessToken);
      } else if (isBoxPersistentClientConfig(config)) {
        return sdk.getPersistentClient(config.tokenInfo);
      } else if (isBoxAppAuthClientConfig(config)) {
        return sdk.getAppAuthClient(config.type, config.id);
      } else {
        return sdk.getAnonymousClient();
      }
    })();
    config.configurator && config.configurator(client);
    return client;
  }

  private sdk: BoxSDK;
  private config: BoxClientConfig;
  private client: box.BoxClient | undefined;

  constructor(appConfig: BoxAppConfig = { boxAppSettings: { clientID: '', clientSecret: '' } }, clientConfig: BoxClientConfig = { kind: 'Anonymous' }) {
    this.sdk = BoxSDK.getPreconfiguredInstance(appConfig);
    this.config = clientConfig;
  }

  public build() {
    return this.client || (this.client = BoxClientBuilder.build(this.sdk, this.config));
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
    return BoxFinder.new(client, current, new LRUCache({ max: 100_000_000, length: sizeof }));
  }

  private static new(client: box.BoxClient, folder: box.MiniFolder, cache: LRUCache<string, box.Item[]>) {
    return new BoxFinder(client, folder, cache);
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

  private static async findFolderByPath(folderPath: string[], finder?: BoxFinder): Promise<box.Folder | undefined> {
    if (finder === undefined) {
      return undefined;
    }
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.folders.get(finder.current.id);
    }
    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    return BoxFinder.findFolderByPath(folderPath.slice(1), subFolder && finder.new(subFolder));
  }

  private files: box.Files;
  private folders: box.Folders;

  private constructor(private client: box.BoxClient, readonly current: box.MiniFolder, private cache: LRUCache<string, box.Item[]>) {
    this.files = proxyToTrapTooManyRequests(client.files);
    this.folders = proxyToTrapTooManyRequests(client.folders);
  }

  public async createFolderUnlessItExists(relativePath: string) {
    const dirs = !relativePath ? [] : relativePath.split(path.sep);
    const foundFolder = await BoxFinder.findFolderByPath(dirs, this);
    return foundFolder || BoxFinder.createFolderByPath(dirs, this);
  }

  public async findFileByPath(relativePath: string) {
    const { dir, base } = path.parse(relativePath);
    const dirs = dir === '' ? [] : dir.split(path.sep);
    const folder = await BoxFinder.findFolderByPath(dirs, this);
    return folder && this.findFileByName(base, folder);
  }

  public findFolderByPath(relativePath: string) {
    const { dir, base } = path.parse(relativePath);
    const dirs = (dir === '' ? [] : dir.split(path.sep)).concat(base);
    return BoxFinder.findFolderByPath(dirs, this);
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
      return chunkedUploader.start().then(cacheItems(this.cache));
    } else {
      return this.files.uploadFile(folderId, name, content, options).then(cacheItems(this.cache));
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
      return chunkedUploader.start().then(cacheItems(this.cache));
    } else {
      return this.files.uploadNewFileVersion(file.id, content, options).then(cacheItems(this.cache));
    }
  }

  private new(folder: box.MiniFolder, cache: LRUCache<string, box.Item[]> = this.cache) {
    return BoxFinder.new(this.client, folder, cache);
  }

  private createFolder(folderName: string, parentFolder: box.MiniFolder = this.current): Promise<box.Folder> {
    const parentFolderId = parentFolder.id;
    return makeRetriable(this.folders.create, this.folders, retryIfFolderConflictError)(parentFolderId, folderName).then(cacheItem(this.cache));
  }

  private findFileByName(fileName: string, parentFolder: box.MiniFolder = this.current) {
    return this.findItemByName<box.MiniFile>(fileName, isMiniFile, parentFolder);
  }

  private findFolderByName(folderName: string, parentFolder: box.MiniFolder = this.current) {
    return this.findItemByName<box.MiniFolder>(folderName, isMiniFolder, parentFolder);
  }

  private async findItemByName<T extends box.Item>(itemName: string, isItem: (item: box.Item) => item is T, parentFolder: box.MiniFolder = this.current): Promise<T | undefined> {
    const filter = (item: T) => item.name.normalize() === itemName.normalize();
    const cachedItem = _.first((this.cache.get(parentFolder.id) || []).filter(isItem).filter(filter));
    if (cachedItem) {
      debug('%s has hit the cache.', cachedItem.name);
      return this.fetchItemWithCondition(cachedItem);
    } else {
      debug('%s was not found in the cache.', itemName);
    }
    for await (const item of this.fetchFolderItems(parentFolder)) {
      if (isItem(item) && filter(item)) {
        return item;
      }
    }
  }

  private async *fetchFolderItems(parentFolder: box.MiniFolder = this.current, marker?: string): AsyncIterableIterator<box.Item> {
    const parentFolderId = parentFolder.id;
    const items = await this.folders.getItems(parentFolderId, { usemarker: true, marker });
    const cachedItems = marker ? this.cache.get(parentFolderId) || [] : [];
    this.cache.set(parentFolderId, cachedItems.concat(items.entries));
    yield* items.entries;
    if (items.next_marker) {
      yield* this.fetchFolderItems(parentFolder, items.next_marker);
    }
  }

  private async fetchItemWithCondition<T extends box.Item>(item: T, options?: { fields?: string }) {
    debug('condition get %s %s (etag: %s)', item.type, item.id, item.etag);
    const basePath = url.resolve(isMiniFolder(item) ? '/folders/' : '/files/', item.id);
    const params = {
      headers: { 'IF-NONE-MATCH': item.etag },
      qs: options,
    };
    try {
      return await this.client.wrapWithDefaultHandler(this.client.get)<T>(basePath, params);
    } catch (error) {
      if (!isResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      switch (error.statusCode) {
        case 304:
          return item;
        case 404:
          return undefined;
        default:
          throw error;
      }
    }
  }
}

const cacheItems = _.curry((cache: LRUCache<string, box.Item[]>, newItems: box.Items) => {
  newItems.entries.forEach(cacheItem(cache));
  return newItems;
});

const cacheItem = _.curry(<T extends box.File | box.Folder>(cache: LRUCache<string, box.Item[]>, newItem: T) => {
  debug('new %s: %o', isMiniFile(newItem) ? 'file' : isMiniFolder(newItem) ? 'folder' : 'item', newItem);
  const parentFolderId = newItem.parent.id;
  const cachedItems = cache.get(parentFolderId) || [];
  cache.set(parentFolderId, _.unionWith([newItem], cachedItems, (a, b) => a.type === b.type && a.id === b.id));
  return newItem;
});

type asyncFn<T, U extends any[]> = (...args: U) => Promise<T>;
type RetryCallback<T, U extends any[], V> =
  (error: any, method: asyncFn<T, U>, that: V, args: U, retryTimes: number, delay: number) => Promise<T>;

function makeRetriable<T, U extends any[], V>(method: asyncFn<T, U>, that: V, callback: RetryCallback<T, U, V>, retryTimes = INIT_RETRY_TIMES, delay = 0): asyncFn<T, U> {
  return async (...args: U): Promise<T> => {
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

const retryIfTooManyRequestsError: RetryCallback<any, any[], any> = (error, method, that, args, retryTimes) => {
  if (!isResponseError(error) || error.statusCode !== 429) { throw error; }

  debug('API Response Error: %s', error.message);
  debug('Retries %d more times.', retryTimes);
  const retryAfter = determineDelayTime(retryTimes, error);
  debug('Tries again in %d milliseconds.', retryAfter);
  return makeRetriable(method, that, retryIfTooManyRequestsError, retryTimes - 1, retryAfter)(...args);
};

const retryIfFolderConflictError: RetryCallback<box.Folder, [string, string], box.Folders> = async (error, method, that, args, retryTimes) => {
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
        return makeRetriable<any, any[], T>(property, subject, retryIfTooManyRequestsError);
      }
      return property;
    }
  });
}

function toRFC3339String(date: Date) {
  return date.toISOString().replace(/\.(\d{3})Z$/, 'Z');
}
