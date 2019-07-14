import BoxSDK from 'box-node-sdk';
import { ReadStream } from 'fs';
import _ from 'lodash';
import path from 'path';
import util from 'util';
import { INIT_RETRY_TIMES } from './config';
import { sleep } from './util';

const debug = util.debuglog('carp-streamer:box');

export function createBoxClient(param: string | object, options: { asUser?: string } = {}): BoxSDK.BoxClient {
  const client = typeof param === 'string'
    ? BoxSDK.getBasicClient(param)
    : BoxSDK.getPreconfiguredInstance(param).getAppAuthClient('enterprise');
  if (options.asUser) {
    client.asUser(options.asUser);
  }
  return client;
}

interface ResponseError extends Error {
  statusCode: number;
  response: any;
  request: any;
}

function isResponseError(error: any): error is ResponseError {
  return error.statusCode && error.response && error.request && error instanceof Error;
}

const isMiniFile = (item: BoxSDK.Item): item is BoxSDK.MiniFile => item.type === 'file';
const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

export class BoxFinder {
  public static async create(client: BoxSDK.BoxClient, folderId = '0') {
    const folders = proxyToTrapTooManyRequests(client.folders);
    const current = await folders.get(folderId);
    return BoxFinder.new(client, current);
  }

  private static new(client: BoxSDK.BoxClient, folder: BoxSDK.MiniFolder) {
    return new BoxFinder(client, folder);
  }

  private static async createFolderByPath(folderPath: string[], finder: BoxFinder): Promise<BoxSDK.Folder> {
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.client.folders.get(finder.current.id);
    }
    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    const folder = subFolder || await makeRetriable(finder.createFolder, finder, BoxFinder.retryIfFolderConflictError)(folderName);
    return this.createFolderByPath(folderPath.slice(1), finder.new(folder));
  }

  private static async _findFolderByPath(folderPath: string[], finder?: BoxFinder): Promise<BoxSDK.Folder | undefined> {
    if (finder === undefined) {
      return undefined;
    }
    if (folderPath.length === 0) {
      return isFolder(finder.current) ? finder.current : await finder.client.folders.get(finder.current.id);
    }
    const folderName = _.first(folderPath) || '';
    const subFolder = await finder.findFolderByName(folderName);
    return BoxFinder._findFolderByPath(folderPath.slice(1), subFolder && finder.new(subFolder));
  }

  private static async retryIfFolderConflictError(error: any, method: asyncFn<BoxSDK.Folder>, that: BoxFinder, args: any[], retryTimes: number): Promise<BoxSDK.Folder> {
    const [folderName] = args;
    debug(`Failed to create folder '%s' (parent folder id: %s).`, folderName, that.current.id);
    if (!isResponseError(error) || error.statusCode !== 409) { throw error; }

    debug('API Response Error: %s', error.message);
    const folder = await that.findFolderByName(folderName);
    if (folder) {
      return that.folders.get(folder.id);
    } else {
      debug('Retries %d more times.', retryTimes);
      const retryAfter = determineDelayTime(retryTimes, error);
      debug(`Waiting time is %d milliseconds.`, retryAfter);
      return makeRetriable(method, that, BoxFinder.retryIfFolderConflictError, retryTimes - 1, retryAfter)(...args);
    }
  }

  private files: BoxSDK.Files;
  private folders: BoxSDK.Folders;

  private constructor(private client: BoxSDK.BoxClient, readonly current: BoxSDK.MiniFolder) {
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

  public uploadFile(base: string, stream: ReadStream, folder?: BoxSDK.MiniFolder) {
    const folderId = (folder || this.current).id;
    return this.files.uploadFile(folderId, base, stream);
  }

  public uploadNewFileVersion(file: BoxSDK.MiniFile, stream: ReadStream) {
    return this.files.uploadNewFileVersion(file.id, stream);
  }

  private new(folder: BoxSDK.MiniFolder) {
    return BoxFinder.new(this.client, folder);
  }

  private async createFolder(folderName: string): Promise<BoxSDK.Folder> {
    const parentFolderId = this.current.id;
    return await this.folders.create(parentFolderId, folderName);
  }

  private findFileByName(fileName: string) {
    return this.findItemByName<BoxSDK.MiniFile>(fileName, isMiniFile);
  }

  private findFolderByName(folderName: string) {
    return this.findItemByName<BoxSDK.MiniFolder>(folderName, isMiniFolder);
  }

  private async findItemByName<T extends BoxSDK.Item>(itemName: string, isItem: (item: BoxSDK.Item) => item is T): Promise<T | undefined> {
    for await (const item of this.fetchFolderItems()) {
      if (isItem(item) && item.name.normalize() === itemName.normalize()) {
        return item;
      }
    }
  }

  private async *fetchFolderItems(marker?: string): AsyncIterableIterator<BoxSDK.Item> {
    const parentFolderId = this.current.id;
    const items = await this.folders.getItems(parentFolderId, { usemarker: true, marker });
    yield* items.entries;
    if (items.next_marker) {
      yield* this.fetchFolderItems(items.next_marker);
    }
  }
}

type asyncFn<T> = (...args: any) => Promise<T>;
type retryCallback<T> =
  (error: any, method: asyncFn<T>, that: any, args: any[], retryTimes: number, delay: number) => Promise<T>;

function makeRetriable<T>(method: asyncFn<T>, that: any, callback: retryCallback<T>, retryTimes = INIT_RETRY_TIMES, delay = 0): asyncFn<T> {
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

function determineDelayTime(retryTimes: number, error?: ResponseError): number {
  const retryAfter = Number(error ? error.response.headers['retry-after'] || 0 : 0);
  return (retryAfter + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
}

function retryIfTooManyRequestsError<T>(error: any, method: asyncFn<T>, that: any, args: any[], retryTimes: number): Promise<T> {
  if (!isResponseError(error) || error.statusCode !== 429) { throw error; }

  debug('API Response Error: %s', error.message);
  debug('Retries %d more times.', retryTimes);
  const retryAfter = determineDelayTime(retryTimes, error);
  debug('Tries again in %d milliseconds.', retryAfter);
  return makeRetriable(method, that, retryIfTooManyRequestsError, retryTimes - 1, retryAfter)(...args);
}

function proxyToTrapTooManyRequests<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (subject: T, propertyKey, receiver) => {
      const property = Reflect.get(subject, propertyKey, receiver);
      if (property instanceof Function) {
        return makeRetriable(property, subject, retryIfTooManyRequestsError);
      }
      return property;
    }
  });
}
