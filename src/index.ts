#!/usr/bin/env node

import _ from 'lodash';
import minimist from 'minimist';
import crypto from 'crypto';
import fs from 'fs';
import path, { resolve } from 'path';
import util from 'util';

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
const findRemoteById = (id: string, folderPath: string = '') => client.folders.getItems(id).then((items: any) => {
  return Promise.all(items.entries.map((entry: any) => {
    const entryPath = path.join(folderPath, entry.name);
    return entry.type === 'folder' ? findRemoteById(entry.id, entryPath) : { path: entryPath, entry };
  }));
});

const findRemoteFolderByPath = (folderPath: string[], rootFolder: any) => {
  if (folderPath.length === 0 || rootFolder === undefined) {
    return rootFolder === undefined || rootFolder.item_collection ? Promise.resolve(rootFolder) : client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath);
  return client.folders.getItems(rootFolder.id).then((items: any) => {
    const entries: Array<any> = items.entries;
    const subFolder = _.first(entries.filter(entry => entry.type === 'folder' && entry.name === folderName));
    return findRemoteFolderByPath(folderPath.slice(1), subFolder);
  });
};

const createRemoteFolderByPath = (folderPath: string[], rootFolder: any) => {
  if (folderPath.length === 0 || rootFolder === undefined) {
    return rootFolder === undefined || rootFolder.item_collection ? Promise.resolve(rootFolder) : client.folders.get(rootFolder.id);
  }

  const folderName = _.first(folderPath);
  return client.folders.getItems(rootFolder.id).then((items: any) => {
    const entries: Array<any> = items.entries;
    const subFolder = _.first(entries.filter(entry => entry.type === 'folder' && entry.name === folderName));
    return new Promise((resolve, reject) => {
      return subFolder ? resolve(subFolder) : client.folders.create(rootFolder.id, folderName).then(resolve);
    }).then((folder: any) => createRemoteFolderByPath(folderPath.slice(1), folder));
  });
};

const digest = (source: string) => new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(source);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('close', () => resolve(hash.digest('hex')));
});

const BoxSDK = require('box-node-sdk');
const client = BoxSDK.getBasicClient(args.t);
client.folders.get(destination).then((rootFolder: any) => {
  Promise.all([
    findLocalByPath(source).then(_.flattenDeep)
    .then(entries => Promise.all(entries.map((entry: any) => digest(entry.path).then(sha1 => {
      return _.assign({sha1}, entry);
    })))),
    findRemoteById(rootFolder.id).then(_.flattenDeep),
  ])
  .then(a => a.map(list => list.reduce((o: any, entry: { path:string }) => {
    const key = (path.isAbsolute(entry.path) ? path.relative(source, entry.path) : entry.path).normalize();
    o[key] = _.merge(entry, {path: key});
    return o;
  }, {})))
  .then(([local, remote]) => _.merge(local, remote))
  .then(map => _.values(map).forEach(e => {
    debug(e);
    if (!e.dirent) {
      console.log(`'${e.path}' only exists remotely.`);
    } else if (e.entry) {
      if (e.sha1 === e.entry.sha1) {
        console.log(`'${e.path}' is synchronized.`);
      } else {
        client.files.uploadNewFileVersion(e.entry.id, fs.createReadStream(path.join(source, e.path)))
          .then((file: any) => {
            console.log(`A new version of '${e.path}' has been uploaded.`);
          });
      }
    } else {
      const { dir, base } = path.parse(path.relative(source, e.path));
      const dirs = dir === '' ? [] : dir.split(path.sep);
      findRemoteFolderByPath(dirs, rootFolder)
        .then((folder: any) => folder || createRemoteFolderByPath(dirs, rootFolder))
        .then((folder: any) => client.files.uploadFile(folder.id, base, fs.createReadStream(e.path)))
        .then((file: any) => {
          console.log(`'${e.path}' is newly uploaded.`);
        })
    }
  }))
});
