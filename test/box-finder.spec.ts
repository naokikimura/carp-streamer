import BoxSDK from 'box-node-sdk';
import BoxClient from 'box-node-sdk/lib/box-client';
import { expect } from 'chai';
import BoxFinder from '../src/box-finder';

describe('BoxFinder', () => {
  let client: BoxClient;

  before(() => {
    const appConfig = JSON.parse(process.env.BOX_APP_CONFIG_JSON || '{}');
    const sdk = BoxSDK.getPreconfiguredInstance(appConfig);
    client = sdk.getAppAuthClient('enterprise');
  });

  describe('create', () => {
    it('should return a finder that currently has a root folder if folderId is not specified', async () => {
      const finder = await BoxFinder.create(client);
      expect(finder.current).to.have.property('id', '0');
    });
  });
});
