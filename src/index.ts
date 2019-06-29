#!/usr/bin/env node

import BoxSDK from 'box-node-sdk';
import _ from 'lodash';
import minimist from 'minimist';
import crypto from 'crypto';
import fs from 'fs';
import path, { resolve } from 'path';
import util from 'util';

enum ResultStatus {
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED
}

class File {

  constructor(private root: string, readonly relativePath: string, private dirent: fs.Dirent, private remoteRoot: BoxSDK.Folder, private remoteFile: BoxSDK.File) {
  }

  get absolutePath() {
    return path.resolve(this.root, this.relativePath);
  }

  synchronize() {
    return new Promise<ResultStatus>((resolve, reject) => {
      if (!this.dirent) {
        resolve(ResultStatus.DOWNLOADED);
      } else if (!this.remoteFile) {
        const { dir, base } = path.parse(this.relativePath);
        const dirs = dir === '' ? [] : dir.split(path.sep);
        findRemoteFolderByPath(dirs, this.remoteRoot)
          .then(folder => folder || createRemoteFolderByPath(dirs, this.remoteRoot))
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

const npmPackage = require('../package.json');
const debug = util.debuglog(npmPackage.name);

const argsOption = {
  'alias': { t: 'token', v: 'version' },
  'string': ['t'],
  'boolean': ['v'],
};
const args = minimist(process.argv.slice(2), argsOption);

if (args.version) {
  console.log(npmPackage.version);
  process.exit(0);
}

const [source, destination] = args._

const readdir = util.promisify(fs.readdir);

const findLocalByPath = (source: string): Promise<any> => readdir(source, { withFileTypes: true })
  .then(entries => entries.map(dirent => {
      const entryPath = path.join(source, dirent.name);
      return { path: entryPath, dirent: dirent };
  }))
  .then(entries => {
    return Promise.all(entries.map(entry => {
      return entry.dirent.isDirectory() ? findLocalByPath(entry.path) : entry;
    }));
  });

const findRemoteById = (id: string, folderPath: string = ''): Promise<any> => client.folders.getItems(id).then(items => {
  return Promise.all(items.entries.map(item => {
    const entryPath = path.join(folderPath, item.name);
    return item.type === 'folder' ? findRemoteById(item.id, entryPath) : { path: entryPath, item };
  }));
});

const isFolder = (item: BoxSDK.MiniFolder): item is BoxSDK.Folder => (item as BoxSDK.Folder).size !== undefined;
const isMiniFolder = (item: BoxSDK.Item): item is BoxSDK.MiniFolder => item.type === 'folder';

const findRemoteFolderByPath = (folderPath: string[], rootFolder?: BoxSDK.MiniFolder): Promise<BoxSDK.Folder | undefined> => {
  if (folderPath.length === 0 || rootFolder === undefined) {
    return rootFolder === undefined || isFolder(rootFolder) ? Promise.resolve(rootFolder) : client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath);
  return client.folders.getItems(rootFolder.id).then(items => {
    const subFolder = _.first(items.entries.filter(isMiniFolder).filter(item => item.name === folderName));
    return findRemoteFolderByPath(folderPath.slice(1), subFolder);
  });
};

const createRemoteFolderByPath = (folderPath: string[], rootFolder: BoxSDK.MiniFolder): Promise<BoxSDK.Folder> => {
  if (folderPath.length === 0) {
    return isFolder(rootFolder) ? Promise.resolve(rootFolder) : client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath) || '';
  return client.folders.getItems(rootFolder.id).then(items => {
    const subFolder = _.first(items.entries.filter(isMiniFolder).filter(item => item.name === folderName));
    return new Promise<BoxSDK.MiniFolder>((resolve, reject) => {
      return subFolder ? resolve(subFolder) : client.folders.create(rootFolder.id, folderName).then(resolve);
    }).then(folder => createRemoteFolderByPath(folderPath.slice(1), folder));
  });
};

const client = BoxSDK.getBasicClient(args.t);
client.folders.get(destination).then(rootFolder => {
  Promise.all([
    findLocalByPath(source).then(_.flattenDeep),
    findRemoteById(rootFolder.id).then(_.flattenDeep),
  ])
  .then(a => a.map(list => list.reduce((o: any, entry: any) => {
    const key = (path.isAbsolute(entry.path) ? path.relative(source, entry.path) : entry.path).normalize();
    o[key] = _.merge(entry, {path: key});
    return o;
  }, {})))
  .then(([local, remote]) => _.merge(local, remote))
  .then(_.values)
  .then(entries => entries.map(e => new File(source, e.path, e.dirent, rootFolder, e.item)))
  .then(files => Promise.all(files.map(async file => {
    debug('%o', file);
    const status = await file.synchronize();
    switch (status) {
      case ResultStatus.DOWNLOADED:
        console.log(`'${file.relativePath}' only exists remotely.`);
        break;
      case ResultStatus.SYNCHRONIZED:
        console.log(`'${file.relativePath}' is synchronized.`);
        break;
      case ResultStatus.UPLOADED:
        console.log(`'${file.relativePath}' is newly uploaded.`);
        break;
      case ResultStatus.UPGRADED:
        console.log(`A new version of '${file.relativePath}' has been uploaded.`);
        break;
    }
  })))
  .then(() => console.log('successful!'))
});
