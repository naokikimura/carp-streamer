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
      return Object.assign({sha1}, entry);
    })))),
    findRemoteById(rootFolder.id).then(_.flattenDeep),
  ])
  .then(a => a.map(list => list.reduce((o: any, entry: { path:string }) => {
    const key = (path.isAbsolute(entry.path) ? path.relative(source, entry.path) : entry.path).normalize();
    o[key] = entry;
    return o;
  }, {})))
  .then(([local, remote]) => _.merge(local, remote))
  .then(map => _.keys(map).forEach(key => {
    const entry = map[key];
    debug(entry);
    if (entry.sha1 === entry && entry.entry.sha1) {
      debug(`${key} is synchronized.`);
      return;
    }
  }))
});
