import BoxSDK from 'box-node-sdk';
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

export interface ResponseError extends Error {
  statusCode: number;
  response: any;
  request: any;
}

export function isResponseError(error: any): error is ResponseError {
  return error.statusCode && error.response && error.request && error instanceof Error;
}

const isMiniFile = (item: BoxSDK.Item): item is BoxSDK.MiniFile => item.type === 'file';
const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

export class BoxFinder {
  public static async create(client: BoxSDK.BoxClient, folderId = '0') {
    const current = await client.folders.get(folderId);
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
    const folder = subFolder || await finder.createFolder(folderName);
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

  constructor(readonly client: BoxSDK.BoxClient, readonly current: BoxSDK.MiniFolder) {
  }

  public async createFolderUnlessItExists(relativePath: string) {
    const dirs = !relativePath ? [] : relativePath.split(path.sep);
    const foundFolder = await BoxFinder._findFolderByPath(dirs, this);
    return foundFolder || await BoxFinder.createFolderByPath(dirs, this);
  }

  public async findFileByPath(relativePath: string) {
    const { dir, base } = path.parse(relativePath);
    const dirs = dir === '' ? [] : dir.split(path.sep);
    const folder = await BoxFinder._findFolderByPath(dirs, this);
    return folder && await this.new(folder).findFileByName(base);
  }

  public findFolderByPath(relativePath: string) {
    const { dir, base } = path.parse(relativePath);
    const dirs = (dir === '' ? [] : dir.split(path.sep)).concat(base);
    return BoxFinder._findFolderByPath(dirs, this);
  }

  private new(folder: BoxSDK.MiniFolder) {
    return BoxFinder.new(this.client, folder);
  }

  private async createFolder(folderName: string, retryTimes = INIT_RETRY_TIMES, delay = 0): Promise<BoxSDK.Folder> {
    const parentFolderId = this.current.id;
    await sleep(delay);
    try {
      return await this.client.folders.create(parentFolderId, folderName);
    } catch (error) {
      debug(`Failed to create folder '%s' (parent folder id: %s).`, folderName, parentFolderId);
      if (!isResponseError(error)) {
        throw error;
      }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 409 && retryTimes > 0)) {
        throw error;
      }
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
    const items = await this.client.folders.getItems(parentFolderId, { usemarker: true, marker });
    yield* items.entries;
    if (items.next_marker) {
      yield* this.fetchFolderItems(items.next_marker);
    }
  }
}

export function retry<T>(method: (...args: any) => Promise<T>, that: any, retryTimes = INIT_RETRY_TIMES, delay = 0): (...args: any) => Promise<T> {
  return async (...args: any): Promise<any> =>  {
    await sleep(delay);
    try {
      return await Reflect.apply(method, that, args);
    } catch (error) {
      if (!isResponseError(error)) { throw error; }
      debug('API Response Error: %s', error.message);
      if (!(error.statusCode === 429 && retryTimes > 0)) { throw error; }

      debug('Retries %d more times.', retryTimes);
      const retryAfter = determineDelayTime(retryTimes, error);
      debug('Tries again in %d milliseconds.', retryAfter);
      debug('Retrying %s...', method.name);
      return retry(method, that, retryTimes - 1, retryAfter)(...args);
    }
  };
}

function determineDelayTime(retryTimes: number, error?: ResponseError): number {
  const retryAfter = Number(error ? error.response.headers['retry-after'] || 0 : 0);
  return (retryAfter + Math.floor(Math.random() * 10 * (1 / retryTimes))) * 1000;
}
