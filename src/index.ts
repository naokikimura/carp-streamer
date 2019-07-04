#!/usr/bin/env node

import BoxSDK from 'box-node-sdk';
import _ from 'lodash';
import minimist from 'minimist';
import async from 'async';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import util from 'util';
import {Entry, ResultStatus, listDirectoryEntriesRecursively} from './app'

const npmPackage = require('../package.json');
const debug = util.debuglog(`${npmPackage.name}:index`);

const argsOption = {
  'alias': { t: 'token', v: 'version', c: 'concurrency' },
  'string': ['t', 'as-user'],
  'boolean': ['v', 'dry-run'],
  'number': ['c'],
  'default': { 'dry-run': false, concurrency: 10 }
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
const concurrency: number = args['concurrency'];

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
const spinner = ora().start('synchronizing...');
client.folders.get(destination).then(async (rootFolder) => {
  const q = async.queue(async ({ path: absolutePath, dirent }, done) => {
    const relativePath = path.relative(rootPath, absolutePath);
    try {
      const entry = await Entry.create(dirent, rootPath, relativePath, rootFolder, client);
      const status = await entry.synchronize(client, pretend);
      switch (status) {
        case ResultStatus.DOWNLOADED:
          spinner.succeed(`'${relativePath}' only exists remotely.`);
          break;
        case ResultStatus.SYNCHRONIZED:
          spinner.succeed(`'${relativePath}' is synchronized.`);
          break;
        case ResultStatus.UPLOADED:
          spinner.succeed(`'${relativePath}' is newly uploaded.`);
          break;
        case ResultStatus.UPGRADED:
          spinner.succeed(`A new version of '${relativePath}' has been uploaded.`);
          break;
        default:
          throw new Error('unknown result status');
      }
      done();
    } catch (error) {
      debug('%s: %s\n%s', error.name, error.message, error.stack);
      spinner.fail(`Failed to synchronize '${relativePath}'.`);
      done(error);
    }
  }, concurrency);
  let count = 0;
  for await (let entry of listDirectoryEntriesRecursively(rootPath)) {
    q.push(entry);
    count++;
  }
  spinner.info(`${count} entries were found.`);
  return await q.drain();
}).then(results => {
  spinner.info('Successful!');
  process.exit(0);
}).catch(reason => {
  debug('%s: %s\n%s', reason.name, reason.message, reason.stack);
  spinner.warn(`Failure! ${reason.name}: ${reason.message}`);
  process.exit(1);
});
