import AnonymousSession from 'box-node-sdk/lib/sessions/anonymous-session';
import AppAuthSession from 'box-node-sdk/lib/sessions/app-auth-session';
import BasicSession from 'box-node-sdk/lib/sessions/basic-session';
import PersistentSession from 'box-node-sdk/lib/sessions/persistent-session';
import { expect } from 'chai';
import BoxClientBuilder, { BoxClientConfig } from '../src/box-client-builder';

describe('box', () => {
  describe('BoxClientBuilder', () => {
    it('anonymous client', done => {
      const client = new BoxClientBuilder().build();
      expect(client).to.have.property('_session').and.to.be.an.instanceOf(AnonymousSession);
      done();
    });

    it('app auth client', done => {
      const appConfig = { boxAppSettings: { clientID: '', clientSecret: '' }, enterpriseID: 'foo' };
      const clientConfig: BoxClientConfig = { kind: 'AppAuth', type: 'enterprise' };
      const client = new BoxClientBuilder(appConfig, clientConfig).build();
      expect(client).to.have.property('_session').and.to.be.an.instanceOf(AppAuthSession);
      done();
    });

    it('basic client', done => {
      const appConfig = { boxAppSettings: { clientID: '', clientSecret: '' } };
      const clientConfig: BoxClientConfig = { kind: 'Basic', accessToken: '' };
      const client = new BoxClientBuilder(appConfig, clientConfig).build();
      expect(client).to.have.property('_session').and.to.be.an.instanceOf(BasicSession);
      done();
    });

    it('persistent client', done => {
      const appConfig = { boxAppSettings: { clientID: '', clientSecret: '' } };
      const tokenInfo = {
        accessToken: 'foo',
        accessTokenTTLMS: -1,
        acquiredAtMS: -1,
        refreshToken: 'bar',
      };
      const clientConfig: BoxClientConfig = { kind: 'Persistent', tokenInfo };
      const client = new BoxClientBuilder(appConfig, clientConfig).build();
      expect(client).to.have.property('_session').and.to.be.an.instanceOf(PersistentSession);
      done();
    });

    it('client configurator', done => {
      const appConfig = { boxAppSettings: { clientID: '', clientSecret: '' } };
      const configurator = (client: any) => { client.asUser('foo'); };
      const clientConfig: BoxClientConfig = { kind: 'Basic', accessToken: '', configurator };
      const boxClient = new BoxClientBuilder(appConfig, clientConfig).build();
      expect(boxClient).to.have.property('_customHeaders').and.to.have.property('As-User', 'foo');
      done();
    });
  });
});
