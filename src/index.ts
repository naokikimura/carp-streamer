#!/usr/bin/env node

import fs from 'fs';
import minimist from 'minimist';
import ora from 'ora';
import path from 'path';
import progress from 'progress';
import { Writable } from 'stream';
import util from 'util';
import { SyncEventType, Synchronizer, SyncResultStatus } from './app';

// tslint:disable-next-line: no-var-requires
const { name: packageName, version: packageVersion } = require('../package.json');
const debug = util.debuglog(`${packageName}:index`);

const argsOption = {
  alias: { t: 'token', v: 'version', c: 'concurrency' },
  boolean: ['v', 'dry-run', 'progress', 'disable-cached-responses-validation'],
  default: {
    'cache-max-age': 1_000 * 60 * 60,
    'cache-max-size': 100_000_000,
    'concurrency': 10,
    'disable-cached-responses-validation': false,
    'dry-run': false,
    'progress': false,
  },
  number: ['c', 'cache-max-size', 'cache-max-age'],
  string: ['t', 'as-user', 'exclude', 'temporary-directory'],
};
const args = minimist(process.argv.slice(2), argsOption);
if (args.version) {
  console.log(packageVersion);
  process.exit(0);
}

const sources = args._.slice(0, -1);
const [destination] = args._.slice(-1);

if (sources.length === 0 || destination === undefined) {
  console.error(`usage: ${packageName} [options] source... destination`);
  process.exit(1);
}

const pretend: boolean = args['dry-run'];
const concurrency: number = args.concurrency;
const needProgress: boolean = args.progress;
const excludes = (args.exclude && [].concat(args.exclude) || [])
  .map(exclude => path.resolve(process.cwd(), exclude));
const nullDevice = new class extends Writable {
  public _write(chunk: any, encoding: any, callback: (erro?: any) => void) {
    callback();
  }
}();
const progressBar = new progress(
  '  synchronizing... [:bar] :percent (:current/:total) :elapseds :etas',
  { total: Number.MAX_SAFE_INTEGER, stream: needProgress ? process.stderr : nullDevice }
);
const spinner = ora({
  stream: process.stdout.isTTY && needProgress ? nullDevice : process.stdout,
}).start('synchronizing...');

(async () => {
  try {
    progressBar.total = 0;
    const appConfig = process.env.BOX_APP_CONFIG && JSON.parse(fs.readFileSync(process.env.BOX_APP_CONFIG).toString());
    const cacheConfig = {
      disableCachedResponsesValidation: Boolean(args['disable-cached-responses-validation']),
      max: Number(args['cache-max-size']),
      maxAge: Number(args['cache-max-age']),
    };
    const synchronizer = await Synchronizer.create(appConfig, args.token, args['as-user'], destination, cacheConfig, args['temporary-directory'], concurrency);
    synchronizer
      .on(SyncEventType.ENTER, absolutePath => {
        progressBar.total = progressBar.total + 1;
      })
      .on(SyncEventType.ENTERED, count => {
        const timestamp = new Date().toISOString();
        spinner.info(`${timestamp}\t${count} entries were found.`);
      })
      .on(SyncEventType.SYNCHRONIZE, (error, absolutePath, status: SyncResultStatus) => {
        const timestamp = new Date().toISOString();
        switch (status) {
          case SyncResultStatus.DENIED:
            debug('%s: %s\n%s', error.name, error.message, error.stack);
            spinner.warn(`${timestamp}\tCould not access '${absolutePath}'.`);
            break;
          case SyncResultStatus.EXCLUDED:
            spinner.info(`${timestamp}\t'${absolutePath}' has been excluded.`);
            break;
          case SyncResultStatus.DOWNLOADED:
            spinner.succeed(`${timestamp}\t'${absolutePath}' only exists remotely.`);
            break;
          case SyncResultStatus.SYNCHRONIZED:
            spinner.succeed(`${timestamp}\t'${absolutePath}' is synchronized.`);
            break;
          case SyncResultStatus.UPLOADED:
            spinner.succeed(`${timestamp}\t'${absolutePath}' is newly uploaded.`);
            break;
          case SyncResultStatus.UPGRADED:
            spinner.succeed(`${timestamp}\tA new version of '${absolutePath}' has been uploaded.`);
            break;
          case SyncResultStatus.CREATED:
            spinner.succeed(`${timestamp}\t'${absolutePath}' is newly created.`);
            break;
          case SyncResultStatus.FAILURE:
            debug('Failed to synchronize \'%s\' %o', absolutePath, error);
            spinner.fail(`${timestamp}\tFailed to synchronize '${absolutePath}'.\t(${error.message})`);
            break;
          case SyncResultStatus.UNKNOWN:
          default:
            spinner.fail(`${timestamp}\t'${absolutePath}' is unknown result status: ${status}`);
        }
        progressBar.tick();
      });
    await synchronizer.begin();
    for await (const source of sources) {
      const rootPath = path.resolve(process.cwd(), source);
      await synchronizer.synchronize(rootPath, excludes, pretend);
    }
    await synchronizer.end();
    if (needProgress) { console.error('Successful!'); }
    progressBar.terminate();
    spinner.info('Successful!');
    process.exit(0);
  } catch (reason) {
    debug('%s: %s\n%s', reason.name, reason.message, reason.stack);
    if (needProgress) { console.error(`Failure! ${reason.name}: ${reason.message}`); }
    progressBar.terminate();
    spinner.warn(`Failure! ${reason.name}: ${reason.message}`);
    process.exit(1);
  }
})();
