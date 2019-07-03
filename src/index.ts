#!/usr/bin/env node

import BoxSDK from 'box-node-sdk';
import _ from 'lodash';
import minimist from 'minimist';
import fs from 'fs';
import path from 'path';
import util from 'util';
import {Entry, ResultStatus, listDirectoryEntriesRecursively} from './app'

const npmPackage = require('../package.json');
const debug = util.debuglog(`${npmPackage.name}:index`);

const argsOption = {
  'alias': { t: 'token', v: 'version' },
  'string': ['t', 'as-user'],
  'boolean': ['v', 'dry-run'],
  'default': { 'dry-run': false }
};
const args = minimist(process.argv.slice(2), argsOption);

if (args.version) {
  console.log(npmPackage.version);
  process.exit(0);
}

const [source, destination] = args._

if (source === undefined || destination === undefined) {
  console.error(`usage: ${npmPackage.name} [options] source destination`);
  process.exit(1);
}

const pretend: boolean = args['dry-run'];

const appConfig = process.env.BOX_APP_CONFIG && JSON.parse(fs.readFileSync(process.env.BOX_APP_CONFIG).toString());
const createBoxClient = (params: { appConfig?: object, token?: string }) => {
  if (params.token) return BoxSDK.getBasicClient(params.token);

  const sdk = BoxSDK.getPreconfiguredInstance(appConfig);
  return sdk.getAppAuthClient('enterprise');
}

const rootPath = path.resolve(process.cwd(), source);
const client = createBoxClient({ appConfig, token: args.token });
if (args['as-user']) {
  client.asUser(args['as-user']);
}
client.folders.get(destination).then(async (rootFolder) => {
  const promises = [];
  for await (let { path: absolutePath, dirent } of listDirectoryEntriesRecursively(rootPath)) {
    const relativePath = path.relative(rootPath, absolutePath);
    const promise = Entry.create(dirent, rootPath, relativePath, rootFolder, client)
    .then(entry => entry.synchronize(client, pretend))
    .then(status => {
      switch (status) {
        case ResultStatus.DOWNLOADED:
          console.log(`'${relativePath}' only exists remotely.`);
          break;
        case ResultStatus.SYNCHRONIZED:
          console.log(`'${relativePath}' is synchronized.`);
          break;
        case ResultStatus.UPLOADED:
          console.log(`'${relativePath}' is newly uploaded.`);
          break;
        case ResultStatus.UPGRADED:
          console.log(`A new version of '${relativePath}' has been uploaded.`);
          break;
        default:
          throw new Error('unknown result status');
      }
      return status;
    }).catch(error => {
      debug('%s: %s', error.name, error.message);
      debug('%s', error.stack);
      console.log(`Failed to synchronize '${relativePath}'.`);
      throw error;
    });
    promises.push(promise);
  }
  console.log(`${promises.length} entries were found.`);
  return Promise.all(promises);
}).then(results => {
  console.log('Successful! %d entries were synchronized.', results.length);
  process.exit(0);
}).catch(reason => {
  console.log('%s: %s', reason.name, reason.message);
  debug('%s', reason.stack);
  console.log(`Failure!`);
  process.exit(1);
});
