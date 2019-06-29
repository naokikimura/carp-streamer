import BoxSDK from 'box-node-sdk';
import _ from 'lodash';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export enum ResultStatus {
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED
}

export class File {

  constructor(private root: string, readonly relativePath: string, private dirent: fs.Dirent, private remoteRoot: BoxSDK.Folder, private remoteFile: BoxSDK.File) {
  }

  get absolutePath() {
    return path.resolve(this.root, this.relativePath);
  }

  synchronize(client: BoxSDK.Client) {
    return new Promise<ResultStatus>((resolve, reject) => {
      if (!this.dirent) {
        resolve(ResultStatus.DOWNLOADED);
      } else if (!this.remoteFile) {
        const { dir, base } = path.parse(this.relativePath);
        const dirs = dir === '' ? [] : dir.split(path.sep);
        findRemoteFolderByPath(dirs, this.remoteRoot, client)
          .then(folder => folder || createRemoteFolderByPath(dirs, this.remoteRoot, client))
          .then(folder => client.files.uploadFile(folder.id, base, this.createReadStream()))
          .then(() => resolve(ResultStatus.UPLOADED)).catch(reject);
      } else {
        this.digest().then(sha1 => {
          if (sha1 === this.remoteFile.sha1) {
            resolve(ResultStatus.SYNCHRONIZED);
          } else {
            client.files.uploadNewFileVersion(this.remoteFile.id, this.createReadStream())
              .then(() => resolve(ResultStatus.UPGRADED)).catch(reject);
          }
        });
      }
    });
  }

  digest() {
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

const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

const findRemoteFolderByPath = (folderPath: string[], rootFolder: BoxSDK.MiniFolder | undefined, client: BoxSDK.Client): Promise<BoxSDK.Folder | undefined> => {
  if (folderPath.length === 0 || rootFolder === undefined) {
    return rootFolder === undefined || isFolder(rootFolder) ? Promise.resolve(rootFolder) : client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath);
  return client.folders.getItems(rootFolder.id).then(items => {
    const subFolder = _.first(items.entries.filter(isMiniFolder).filter(item => item.name === folderName));
    return findRemoteFolderByPath(folderPath.slice(1), subFolder, client);
  });
};

const createRemoteFolderByPath = (folderPath: string[], rootFolder: BoxSDK.MiniFolder, client: BoxSDK.Client): Promise<BoxSDK.Folder> => {
  if (folderPath.length === 0) {
    return isFolder(rootFolder) ? Promise.resolve(rootFolder) : client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath) || '';
  return client.folders.getItems(rootFolder.id).then(items => {
    const subFolder = _.first(items.entries.filter(isMiniFolder).filter(item => item.name === folderName));
    return new Promise<BoxSDK.MiniFolder>((resolve, reject) => {
      return subFolder ? resolve(subFolder) : client.folders.create(rootFolder.id, folderName).then(resolve);
    }).then(folder => createRemoteFolderByPath(folderPath.slice(1), folder, client));
  });
};
