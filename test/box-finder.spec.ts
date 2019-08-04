/// <reference types="../src/@types/box-node-sdk" />

import BoxSDK, * as box from 'box-node-sdk';
import BoxClient from 'box-node-sdk/lib/box-client';
import { expect } from 'chai';
import sinon from 'sinon';
import url from 'url';
import BoxFinder from '../src/box-finder';

describe('BoxFinder', () => {
  const miniRoot: box.MiniFolder = {
    etag: null,
    id: '0',
    name: 'All Files',
    sequence_id: null,
    type: 'folder',
  };
  const miniBar: box.MiniFolder = {
    etag: '0',
    id: '83590645751',
    name: 'bar',
    sequence_id: '0',
    type: 'folder',
  };
  const miniQux: box.MiniFolder = {
    etag: '0',
    id: '83590285643',
    name: 'qux',
    sequence_id: '0',
    type: 'folder',
  };
  const owner: box.MiniUser = {
    id: '9509820799',
    login: 'AutomationUser_850125_CVuSw4ZSaN@boxdevedition.com',
    name: 'carp-streamer test',
    type: 'user'
  };
  const foo: box.File = {
    content_created_at: '2019-08-02T19:31:48-07:00',
    content_modified_at: '2019-08-02T19:31:48-07:00',
    created_at: '2019-08-02T19:31:48-07:00',
    created_by: owner,
    description: '',
    etag: '0',
    file_version: {
      id: '530819697597',
      sha1: '430ce34d020724ed75a196dfc2ad67c77772d169',
      type: 'file_version',
    },
    id: '501330364797',
    item_status: 'active',
    modified_at: '2019-08-02T19:31:48-07:00',
    modified_by: owner,
    name: 'foo',
    owned_by: owner,
    parent: miniRoot,
    path_collection: {
      entries: [miniRoot],
      total_count: 1,
    },
    purged_at: null,
    sequence_id: '0',
    sha1: '430ce34d020724ed75a196dfc2ad67c77772d169',
    shared_link: null,
    size: 12,
    trashed_at: null,
    type: 'file',
  };
  const baz: box.File = {
    content_created_at: '2019-08-02T22:09:51-07:00',
    content_modified_at: '2019-08-02T22:09:51-07:00',
    created_at: '2019-08-02T22:09:51-07:00',
    created_by: owner,
    description: '',
    etag: '0',
    file_version: {
      id: '530872851720',
      sha1: '8843d7f92416211de9ebb963ff4ce28125932878',
      type: 'file_version',
    },
    id: '501382032120',
    item_status: 'active',
    modified_at: '2019-08-02T22:09:51-07:00',
    modified_by: owner,
    name: 'baz',
    owned_by: owner,
    parent: miniRoot,
    path_collection: {
      entries: [miniRoot],
      total_count: 1,
    },
    purged_at: null,
    sequence_id: '0',
    sha1: '8843d7f92416211de9ebb963ff4ce28125932878',
    shared_link: null,
    size: 6,
    trashed_at: null,
    type: 'file',
  };
  const waldo: box.File = {
    content_created_at: '2019-08-03T06:11:23-07:00',
    content_modified_at: '2019-08-03T06:11:23-07:00',
    created_at: '2019-08-03T06:11:23-07:00',
    created_by: owner,
    description: '',
    etag: '0',
    file_version: {
      id: '530995245266',
      sha1: '5d17a08dd7ebfa7188ef65e7f840e541be10eed5',
      type: 'file_version',
    },
    id: '501499505666',
    item_status: 'active',
    modified_at: '2019-08-03T06:11:23-07:00',
    modified_by: owner,
    name: 'waldo',
    owned_by: owner,
    parent: miniBar,
    path_collection: {
      entries: [miniRoot, miniBar],
      total_count: 2,
    },
    purged_at: null,
    sequence_id: '0',
    sha1: '5d17a08dd7ebfa7188ef65e7f840e541be10eed5',
    shared_link: null,
    size: 5,
    trashed_at: null,
    type: 'file',
  };
  const qux: box.Folder = {
    content_created_at: '2019-08-02T21:27:33-07:00',
    content_modified_at: '2019-08-02T21:27:33-07:00',
    created_at: '2019-08-02T21:27:33-07:00',
    created_by: owner,
    description: '',
    etag: miniQux.etag,
    id: miniQux.id,
    item_collection: {
      entries: [],
      limit: 100,
      offset: 0,
      order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
      total_count: 0,
    },
    item_status: 'active',
    modified_at: '2019-08-02T21:27:33-07:00',
    modified_by: owner,
    name: miniQux.name,
    owned_by: owner,
    parent: miniRoot,
    path_collection: {
      entries: [miniRoot, miniBar],
      total_count: 2
    },
    purged_at: null,
    sequence_id: miniQux.sequence_id,
    shared_link: null,
    size: 0,
    trashed_at: null,
    type: miniQux.type,
  };
  const bar: box.Folder = {
    content_created_at: '2019-08-02T20:44:37-07:00',
    content_modified_at: '2019-08-02T20:44:37-07:00',
    created_at: '2019-08-02T20:44:37-07:00',
    created_by: owner,
    description: '',
    etag: miniBar.etag,
    folder_upload_email: null,
    id: miniBar.id,
    item_collection: {
      entries: [qux, waldo],
      limit: 100,
      offset: 0,
      order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
      total_count: 2,
    },
    item_status: 'active',
    modified_at: '2019-08-02T20:44:37-07:00',
    modified_by: owner,
    name: miniBar.name,
    owned_by: owner,
    parent: miniRoot,
    path_collection: {
      entries: [miniRoot],
      total_count: 1,
    },
    purged_at: null,
    sequence_id: miniBar.sequence_id,
    shared_link: null,
    size: 0,
    trashed_at: null,
    type: miniBar.type,
  };
  const root: box.Folder = {
    content_created_at: null,
    content_modified_at: null,
    created_at: null,
    created_by: { id: '', login: '', name: '', type: 'user' },
    description: '',
    etag: miniRoot.etag,
    folder_upload_email: null,
    id: miniRoot.id,
    item_collection: {
      entries: [bar, foo],
      limit: 100,
      offset: 0,
      order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
      total_count: 2
    },
    item_status: 'active',
    modified_at: null,
    modified_by: owner,
    name: miniRoot.name,
    owned_by: owner,
    parent: null,
    path_collection: { entries: [], total_count: 0 },
    purged_at: null,
    sequence_id: miniRoot.sequence_id,
    shared_link: null,
    size: 0,
    trashed_at: null,
    type: miniRoot.type,
  };
  const corge: box.Folder = {
    etag: '0',
    id: '9999999999',
    name: 'corge',
    parent: miniRoot,
    type: 'folder',
  };
  const quux: box.Folder = {
    etag: '0',
    id: '9999999998',
    name: 'quux',
    parent: miniQux,
    type: 'folder'
  };
  const grault: box.Folder = {
    etag: '0',
    id: '9999999997',
    name: 'grault',
    parent: miniRoot,
    type: 'folder',
  };
  const garply: box.Folder = {
    etag: '0',
    id: '9999999996',
    name: 'garply',
    parent: grault,
    type: 'folder',
  };
  const client = BoxSDK.getBasicClient('');
  let stub: sinon.SinonStubbedInstance<BoxClient>;

  class NotModifiedError extends Error {
    public statusCode = 304;
    public request = {};
    public response = {};
  }

  beforeEach(() => {
    stub = sinon.stub(client);
    stub.wrapWithDefaultHandler.restore();
    stub.get
      .withArgs(url.resolve('/folders/', root.id), { qs: undefined }).resolves(root)
      .withArgs(url.resolve('/folders/', bar.id), { qs: undefined }).resolves(bar)
      .withArgs(url.resolve('/folders/', qux.id), { qs: undefined }).resolves(qux)
      .withArgs(url.resolve('/files/', foo.id), { qs: undefined }).resolves(foo)
      .withArgs(url.resolve('/files/', baz.id), { qs: undefined }).resolves(baz)
      .withArgs(url.resolve('/files/', waldo.id), { qs: undefined }).resolves(waldo)
      .withArgs(url.resolve('/folders/', root.id), { headers: { 'IF-NONE-MATCH': root.etag }, qs: undefined })
      .rejects(new NotModifiedError())
      .withArgs(url.resolve('/folders/', bar.id), { headers: { 'IF-NONE-MATCH': bar.etag }, qs: undefined })
      .rejects(new NotModifiedError())
      .withArgs(url.resolve('/folders/', qux.id), { headers: { 'IF-NONE-MATCH': qux.etag }, qs: undefined })
      .rejects(new NotModifiedError())
      .withArgs(url.resolve('/files/', foo.id), { headers: { 'IF-NONE-MATCH': foo.etag }, qs: undefined })
      .rejects(new NotModifiedError())
      .withArgs(url.resolve('/files/', baz.id), { headers: { 'IF-NONE-MATCH': baz.etag }, qs: undefined })
      .rejects(new NotModifiedError())
      .withArgs(url.resolve('/files/', waldo.id), { headers: { 'IF-NONE-MATCH': waldo.etag }, qs: undefined })
      .rejects(new NotModifiedError())
      .withArgs(`${url.resolve('/folders/', root.id)}/items`, { qs: { marker: undefined, usemarker: true } })
      .resolves({
        entries: [foo, bar, baz],
        limit: 100,
        order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
        total_count: 3,
      })
      .withArgs(`${url.resolve('/folders/', bar.id)}/items`, { qs: { marker: undefined, usemarker: true } })
      .resolves({
        entries: [qux, waldo],
        limit: 100,
        order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
        total_count: 2,
      })
      .withArgs(`${url.resolve('/folders/', qux.id)}/items`, { qs: { marker: undefined, usemarker: true } })
      .resolves({
        entries: [],
        limit: 100,
        order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
        total_count: 0,
      });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('create', () => {
    it('should return a finder that currently has a root folder if folderId is not specified', async () => {
      const expected = root;
      const finder = await BoxFinder.create(client);
      expect(finder.current).to.have.property('id', expected.id);
    });

    it('should return a finder that currently has a specified folder if folderId is specified', async () => {
      const expected = bar;
      const finder = await BoxFinder.create(client, expected.id);
      expect(finder.current).to.have.property('id', expected.id);
    });
  });

  describe('createFolderUnlessItExists', () => {
    it('should return existing folder if folder exists', async () => {
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.createFolderUnlessItExists('bar')).to.have.property('id', bar.id);
      expect(await finder.createFolderUnlessItExists('bar/qux')).to.have.property('id', qux.id);
    });

    it('should return new folder if folder does not exist', async () => {
      stub.get
        .withArgs(url.resolve('/folders/', quux.id), { qs: undefined }).resolves(quux)
        .withArgs(url.resolve('/folders/', corge.id), { qs: undefined }).resolves(corge)
        .withArgs(url.resolve('/folders/', grault.id), { qs: undefined }).resolves(grault)
        .withArgs(url.resolve('/folders/', garply.id), { qs: undefined }).resolves(garply)
        .withArgs(`${url.resolve('/folders/', grault.id)}/items`, { qs: { marker: undefined, usemarker: true } })
        .resolves({
          entries: [],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 0,
        });
      stub.post
        .withArgs('/folders', { body: { name: corge.name, parent: { id: corge.parent && corge.parent.id } } })
        .resolves(corge)
        .withArgs('/folders', { body: { name: quux.name, parent: { id: quux.parent && quux.parent.id } } })
        .resolves(quux)
        .withArgs('/folders', { body: { name: grault.name, parent: { id: grault.parent && grault.parent.id } } })
        .resolves(grault)
        .withArgs('/folders', { body: { name: garply.name, parent: { id: garply.parent && garply.parent.id } } })
        .resolves(garply);
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.createFolderUnlessItExists('corge')).to.have.property('id', corge.id);
      expect(await finder.createFolderUnlessItExists('grault/garply')).to.have.property('id', garply.id);
      expect(await finder.createFolderUnlessItExists('bar/qux/quux')).to.have.property('id', quux.id);
    });
  });

  describe('findFileByPath', () => {
    it('should return the file if the file exists', async () => {
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.findFileByPath('foo')).to.have.property('id', foo.id);
      expect(await finder.findFileByPath('bar/waldo')).to.have.property('id', waldo.id);
    });

    it('should return an undefined if the file does not exists', async () => {
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.findFileByPath('fred')).to.be.an('undefined');
      expect(await finder.findFileByPath('bar/plugh')).to.be.an('undefined');
      expect(await finder.findFileByPath('bar/qux/xyzzy')).to.be.an('undefined');
    });
  });

  describe('findFolderByPath', () => {
    it('should return the folder if the foler exists', async () => {
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.findFolderByPath('bar')).to.have.property('id', bar.id);
      expect(await finder.findFolderByPath('bar/qux')).to.have.property('id', qux.id);
    });

    it('should return an undefined if the folder does not exists', async () => {
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.findFolderByPath('fred')).to.be.an('undefined');
      expect(await finder.findFolderByPath('foo')).to.be.an('undefined');
      expect(await finder.findFolderByPath('bar/plugh')).to.be.an('undefined');
      expect(await finder.findFolderByPath('bar/qux/xyzzy')).to.be.an('undefined');
    });
  });
});
