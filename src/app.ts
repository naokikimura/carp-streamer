import * as box from 'box-node-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import util from 'util';
import { BoxFinder } from './box';

export enum ResultStatus {
  DOWNLOADED,
  SYNCHRONIZED,
  UPLOADED,
  UPGRADED,
  CREATED
}

const debug = util.debuglog('carp-streamer:app');

export abstract class Entry {
  get absolutePath() {
    return path.resolve(this.rootPath, this.relativePath);
  }

  public static async create(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent) {
    if (!dirent) {
      // TODO:
      throw new Error('Not Implemented Error');
    } else if (dirent.isDirectory()) {
      const remoteFolder = await finder.findFolderByPath(relativePath);
      return new Directory(rootPath, relativePath, finder, dirent, remoteFolder);
    } else {
      const remoteFile = await finder.findFileByPath(relativePath);
      return new File(rootPath, relativePath, finder, dirent, remoteFile);
    }
  }

  constructor(private rootPath: string, readonly relativePath: string, protected finder: BoxFinder, protected dirent?: fs.Dirent) { }

  public abstract synchronize(pretend?: boolean): Promise<ResultStatus>;
}

class Directory extends Entry {
  constructor(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, private remoteFolder?: box.MiniFolder) {
    super(rootPath, relativePath, finder, dirent);
  }

  public async synchronize(pretend: boolean = false) {
    if (this.remoteFolder) {
      return ResultStatus.SYNCHRONIZED;
    } else {
      if (!pretend) { await this.finder.createFolderUnlessItExists(this.relativePath); }
      return ResultStatus.CREATED;
    }
  }
}

class File extends Entry {
  constructor(rootPath: string, relativePath: string, finder: BoxFinder, dirent?: fs.Dirent, private remoteFile?: box.MiniFile) {
    super(rootPath, relativePath, finder, dirent);
  }

  public async synchronize(pretend: boolean = false) {
    if (!this.dirent) {
      // client.files.getReadStream()
      return ResultStatus.DOWNLOADED;
    } else if (!this.remoteFile) {
      if (!pretend) {
        const { dir, base } = path.parse(this.relativePath);
        const folder = await this.finder.createFolderUnlessItExists(dir);
        debug('Uploading `%s`...', this.relativePath);
        await this.finder.uploadFile(base, this.createReadStream(), folder);
      }
      return ResultStatus.UPLOADED;
    } else {
      const sha1 = await this.digest();
      if (sha1 === this.remoteFile.sha1) {
        return ResultStatus.SYNCHRONIZED;
      } else {
        if (!pretend) {
          debug('Upgrading `%s`...', this.relativePath);
          await this.finder.uploadNewFileVersion(this.remoteFile, this.createReadStream());
        }
        return ResultStatus.UPGRADED;
      }
    }
  }

  private digest() {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = this.createReadStream();
      stream.on('data', chunk => hash.update(chunk));
      stream.on('close', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private createReadStream() {
    return fs.createReadStream(this.absolutePath);
  }
}

export function createDirentFromStats(stats: fs.Stats, name: string): fs.Dirent {
  return new class extends fs.Dirent {
    get name() { return name; }
    public isBlockDevice() { return stats.isBlockDevice(); }
    public isCharacterDevice() { return stats.isCharacterDevice(); }
    public isDirectory() { return stats.isDirectory(); }
    public isFIFO() { return stats.isFIFO(); }
    public isFile() { return stats.isFile(); }
    public isSocket() { return stats.isSocket(); }
    public isSymbolicLink() { return stats.isSymbolicLink(); }
  }();
}

interface Entity {
  path: string;
  dirent?: fs.Dirent;
  error?: any;
}

const readdirAsync = util.promisify(fs.readdir);
export async function* listDirectoryEntriesRecursively(root: string): AsyncIterableIterator<Entity> {
  try {
    for (const dirent of await readdirAsync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, dirent.name);
      yield ({ path: entryPath, dirent, error: null });
      if (dirent.isDirectory()) {
        yield* listDirectoryEntriesRecursively(entryPath);
      }
    }
  } catch (error) {
    yield { path: root, dirent: undefined, error };
  }
}
