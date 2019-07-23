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
const npmPackage = require('../package.json');
const debug = util.debuglog(`${npmPackage.name}:index`);

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
  string: ['t', 'as-user', 'exclude'],
};
const args = minimist(process.argv.slice(2), argsOption);
if (args.version) {
  console.log(npmPackage.version);
  process.exit(0);
}

const sources = args._.slice(0, -1);
const [destination] = args._.slice(-1);

if (sources.length === 0 || destination === undefined) {
  console.error(`usage: ${npmPackage.name} [options] source... destination`);
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
    const synchronizer = new Synchronizer(appConfig, args.token, args['as-user'], concurrency, cacheConfig);
    synchronizer
      .on(SyncEventType.ENTER, absolutePath => {
        debug('found %s', absolutePath);
        progressBar.total = progressBar.total + 1;
      })
      .on(SyncEventType.ENTERED, count => {
        spinner.info(`${count} entries were found.`);
      })
      .on(SyncEventType.SYNCHRONIZE, (error, absolutePath, status: SyncResultStatus) => {
        switch (status) {
          case SyncResultStatus.DENIED:
            debug('%s: %s\n%s', error.name, error.message, error.stack);
            spinner.warn(`Could not access '${absolutePath}'.`);
            break;
          case SyncResultStatus.EXCLUDED:
            spinner.info(`'${absolutePath}' has been excluded.`);
            break;
          case SyncResultStatus.DOWNLOADED:
            spinner.succeed(`'${absolutePath}' only exists remotely.`);
            break;
          case SyncResultStatus.SYNCHRONIZED:
            spinner.succeed(`'${absolutePath}' is synchronized.`);
            break;
          case SyncResultStatus.UPLOADED:
            spinner.succeed(`'${absolutePath}' is newly uploaded.`);
            break;
          case SyncResultStatus.UPGRADED:
            spinner.succeed(`A new version of '${absolutePath}' has been uploaded.`);
            break;
          case SyncResultStatus.CREATED:
            spinner.succeed(`'${absolutePath}' is newly created.`);
            break;
          case SyncResultStatus.FAILURE:
            debug('%s: %s\n%s', error.name, error.message, error.stack);
            spinner.fail(`Failed to synchronize '${absolutePath}'. (${error.message})`);
            break;
          case SyncResultStatus.UNKNOWN:
          default:
            spinner.fail('unknown result status');
        }
        progressBar.tick();
      });
    for await (const source of sources) {
      const rootPath = path.resolve(process.cwd(), source);
      await synchronizer.synchronize(rootPath, destination, excludes, pretend);
    }
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
