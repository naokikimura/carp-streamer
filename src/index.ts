#!/usr/bin/env node

import BoxSDK from 'box-node-sdk';
import _ from 'lodash';
import minimist from 'minimist';
import path from 'path';
import util from 'util';
import {File, ResultStatus, list, findRemoteFileByPath, findRemoteFolderByPath} from './app'

const npmPackage = require('../package.json');
const debug = util.debuglog(npmPackage.name);

const argsOption = {
  'alias': { t: 'token', v: 'version' },
  'string': ['t'],
  'boolean': ['v', 'dry-run'],
  'default': { 'dry-run': false }
};
const args = minimist(process.argv.slice(2), argsOption);

if (args.version) {
  console.log(npmPackage.version);
  process.exit(0);
}

const [source, destination] = args._
const pretend: boolean = args['dry-run'];

const client = BoxSDK.getBasicClient(args.t);
client.folders.get(destination).then(async function(rootFolder) {
  for await (let { path: absolutePath, dirent } of list(source)) {
    const relativePath = path.relative(source, absolutePath);
    if (dirent.isDirectory()) continue;
    const { dir, base } = path.parse(relativePath);
    const dirs = dir === '' ? [] : dir.split(path.sep);
    const remoteFile = await findRemoteFileByPath(dirs, base, rootFolder, client);
    const file = new File(source, relativePath, dirent, rootFolder, remoteFile);
    debug('%o', file);
    const status = await file.synchronize(client, pretend);
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
      default:
        throw new Error('unknown result status');
    }
  }
}).then(() => console.log('successful!'));