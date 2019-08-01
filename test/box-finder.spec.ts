import BoxSDK, * as box from 'box-node-sdk';
import { expect } from 'chai';
import sinon from 'sinon';
import BoxFinder from '../src/box-finder';

describe('BoxFinder', () => {
  describe('create', () => {
    it('should return a finder that currently has a root folder if folderId is not specified', async () => {
      const client = BoxSDK.getBasicClient('');
      const expected: box.Folder = {
        allowed_invitee_roles: [],
        allowed_shared_link_access_levels: [],
        can_non_owners_invite: false,
        content_created_at: null,
        content_modified_at: null,
        created_at: '',
        created_by: { id: '', login: '', name: '', type: 'user' },
        description: '',
        etag: null,
        folder_upload_email: null,
        has_collaborations: false,
        id: '0',
        is_collaboration_restricted_to_enterprise: false,
        is_externally_owned: false,
        item_collection: { entries: [], limit: 0, order: [] },
        item_status: 'active',
        modified_at: '',
        modified_by: { id: '', login: '', name: '', type: 'user' },
        name: '',
        owned_by: { id: '', login: '', name: '', type: 'user' },
        parent: { etag: null, id: '0', name: '', sequence_id: null, type: 'folder'},
        path_collection: { entries: [], total_count: 0 },
        permissions: { can_download: false },
        purged_at: null,
        sequence_id: null,
        shared_link: null,
        size: 0,
        sync_state: 'synced',
        tags: [],
        trashed_at: null,
        type: 'folder',
        watermark_info: { is_watermarked: false }
      };
      sinon.stub(client.folders, 'get').withArgs('0').returns(Promise.resolve(expected));
      const finder = await BoxFinder.create(client);
      expect(finder.current).to.have.property('id', '0');
    });
  });
});
