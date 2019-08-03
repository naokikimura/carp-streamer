/// <reference types="../src/@types/box-node-sdk" />

import BoxSDK, * as box from 'box-node-sdk';
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
      entries: [qux],
      limit: 100,
      offset: 0,
      order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
      total_count: 1,
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

  describe('create', () => {
    it('should return a finder that currently has a root folder if folderId is not specified', async () => {
      const expected = root;
      const client = BoxSDK.getBasicClient('');
      sinon.stub(client.folders, 'get').withArgs(expected.id).returns(Promise.resolve(expected));
      const finder = await BoxFinder.create(client);
      expect(finder.current).to.have.property('id', expected.id);
    });

    it('should return a finder that currently has a specified folder if folderId is specified', async () => {
      const expected = bar;
      const client = BoxSDK.getBasicClient('');
      sinon.stub(client.folders, 'get').withArgs(expected.id).returns(Promise.resolve(expected));
      const finder = await BoxFinder.create(client, expected.id);
      expect(finder.current).to.have.property('id', expected.id);
    });
  });

  describe('createFolderUnlessItExists', () => {
    it('should return existing folder if folder exists', async () => {
      const client = BoxSDK.getBasicClient('');
      sinon.stub(client, 'get')
        .withArgs(url.resolve('/folders/', root.id), { headers: { 'IF-NONE-MATCH': root.etag }, qs: undefined })
        .returns(Promise.resolve(root))
        .withArgs(url.resolve('/folders/', bar.id), { headers: { 'IF-NONE-MATCH': bar.etag }, qs: undefined })
        .returns(Promise.resolve(bar))
        .withArgs(url.resolve('/folders/', qux.id), { headers: { 'IF-NONE-MATCH': qux.etag }, qs: undefined })
        .returns(Promise.resolve(qux));
      sinon.stub(client.folders, 'get')
        .withArgs(root.id).returns(Promise.resolve(root))
        .withArgs(bar.id).returns(Promise.resolve(bar))
        .withArgs(qux.id).returns(Promise.resolve(qux));
      sinon.stub(client.folders, 'getItems')
        .withArgs(root.id).returns(Promise.resolve({
          entries: [foo, bar, baz],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 3,
        }))
        .withArgs(bar.id).returns(Promise.resolve({
          entries: [qux],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 1,
        }))
        .withArgs(qux.id).returns(Promise.resolve({
          entries: [],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 0,
        }));
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.createFolderUnlessItExists('bar')).to.have.property('id', bar.id);
      expect(await finder.createFolderUnlessItExists('bar/qux')).to.have.property('id', qux.id);
    });

    it('should return new folder if folder does not exist', async () => {
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
      sinon.stub(client, 'get')
        .withArgs(url.resolve('/folders/', root.id), { headers: { 'IF-NONE-MATCH': root.etag }, qs: undefined })
        .returns(Promise.resolve(root))
        .withArgs(url.resolve('/folders/', bar.id), { headers: { 'IF-NONE-MATCH': bar.etag }, qs: undefined })
        .returns(Promise.resolve(bar))
        .withArgs(url.resolve('/folders/', qux.id), { headers: { 'IF-NONE-MATCH': qux.etag }, qs: undefined })
        .returns(Promise.resolve(qux));
      sinon.stub(client.folders, 'get')
        .withArgs(root.id).returns(Promise.resolve(root))
        .withArgs(bar.id).returns(Promise.resolve(bar))
        .withArgs(qux.id).returns(Promise.resolve(qux))
        .withArgs(corge.id).returns(Promise.resolve(corge))
        .withArgs(grault.id).returns(Promise.resolve(grault))
        .withArgs(garply.id).returns(Promise.resolve(garply))
        .withArgs(quux.id).returns(Promise.resolve(quux));
      sinon.stub(client.folders, 'getItems')
        .withArgs(root.id).returns(Promise.resolve({
          entries: [foo, bar, baz],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 3,
        }))
        .withArgs(bar.id).returns(Promise.resolve({
          entries: [qux],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 1,
        }))
        .withArgs(qux.id).returns(Promise.resolve({
          entries: [],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 0,
        }))
        .withArgs(grault.id).returns(Promise.resolve({
          entries: [],
          limit: 100,
          order: [{ by: 'type', direction: 'ASC' }, { by: 'name', direction: 'ASC' }],
          total_count: 0,
        }));
      sinon.stub(client.folders, 'create')
        .withArgs(corge.parent && corge.parent.id || '', corge.name || '').returns(Promise.resolve(corge))
        .withArgs(grault.parent && grault.parent.id || '', grault.name || '').returns(Promise.resolve(grault))
        .withArgs(garply.parent && garply.parent.id || '', garply.name || '').returns(Promise.resolve(garply))
        .withArgs(quux.parent && quux.parent.id || '', quux.name || '').returns(Promise.resolve(quux));
      const finder = await BoxFinder.create(client, '0');
      expect(await finder.createFolderUnlessItExists('corge')).to.have.property('id', corge.id);
      expect(await finder.createFolderUnlessItExists('grault/garply')).to.have.property('id', garply.id);
      expect(await finder.createFolderUnlessItExists('bar/qux/quux')).to.have.property('id', quux.id);
    });
  });
});
