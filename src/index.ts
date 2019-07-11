#!/usr/bin/env node

import async from 'async';
import fs from 'fs';
import minimist from 'minimist';
import ora from 'ora';
import path from 'path';
import progress from 'progress';
import { Writable } from 'stream';
import util from 'util';
import { createDirentFromStats, Entry, listDirectoryEntriesRecursively, ResultStatus } from './app';
import { BoxFinder, createBoxClient } from './box';

// tslint:disable-next-line: no-var-requires
const npmPackage = require('../package.json');
const debug = util.debuglog(`${npmPackage.name}:index`);

const argsOption = {
  alias: { t: 'token', v: 'version', c: 'concurrency' },
  boolean: ['v', 'dry-run', 'progress'],
  default: { 'dry-run': false, 'concurrency': 10, 'progress': false },
  number: ['c'],
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
    const appConfig = process.env.BOX_APP_CONFIG && JSON.parse(fs.readFileSync(process.env.BOX_APP_CONFIG).toString());
    const client = createBoxClient(args.token || appConfig, { asUser: args['as-user'] });
    const q = async.queue(worker, concurrency);
    const finder = await BoxFinder.create(client, destination);
    let count = 0;
    for await (const source of sources) {
      const rootPath = path.resolve(process.cwd(), source);
      const stats = fs.statSync(rootPath);
      if (!stats.isDirectory()) {
        const { dir, base } = path.parse(rootPath);
        const entry = { path: rootPath, dirent: createDirentFromStats(stats, base), error: null };
        q.push({ entry, rootPath: dir, finder });
        count++;
        continue;
      }
      for await (const entry of listDirectoryEntriesRecursively(rootPath)) {
        q.push({ entry, rootPath, finder });
        count++;
      }
    }
    progressBar.total = count;
    spinner.info(`${count} entries were found.`);
    const results = await q.drain();
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

interface Task {
  entry: { path: string, dirent?: fs.Dirent, error?: any };
  rootPath: string;
  finder: BoxFinder;
}

async function worker(task: Task, done: async.ErrorCallback) {
  const { entry: { path: absolutePath, dirent, error }, rootPath, finder } = task;
  const relativePath = path.relative(rootPath, absolutePath);
  if (error) {
    debug('%s: %s\n%s', error.name, error.message, error.stack);
    spinner.warn(`Could not access '${absolutePath}'.`);
    return done(error);
  }
  if (excludes.some(exclude => absolutePath.startsWith(exclude))) {
    spinner.info(`'${absolutePath}' has been excluded.`);
    return done();
  }
  try {
    const entry = await Entry.create(rootPath, relativePath, finder, dirent);
    const status = await entry.synchronize(pretend);
    switch (status) {
      case ResultStatus.DOWNLOADED:
        spinner.succeed(`'${absolutePath}' only exists remotely.`);
        break;
      case ResultStatus.SYNCHRONIZED:
        spinner.succeed(`'${absolutePath}' is synchronized.`);
        break;
      case ResultStatus.UPLOADED:
        spinner.succeed(`'${absolutePath}' is newly uploaded.`);
        break;
      case ResultStatus.UPGRADED:
        spinner.succeed(`A new version of '${absolutePath}' has been uploaded.`);
        break;
      case ResultStatus.CREATED:
        spinner.succeed(`'${absolutePath}' is newly created.`);
        break;
      default:
        throw new Error('unknown result status');
    }
    done();
  } catch (error) {
    debug('%s: %s\n%s', error.name, error.message, error.stack);
    spinner.fail(`Failed to synchronize '${absolutePath}'.`);
    done(error);
  }
  progressBar.tick();
}
