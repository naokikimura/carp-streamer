
declare module 'box-node-sdk' {
  import { ReadStream } from 'fs';
  import { EventEmitter } from 'events';

  interface BoxSDKNodeConstructor {
    new(params: UserConfigurationOptions): BoxSDKNode
    getBasicClient(accessToken: string): BoxClient;
    getPreconfiguredInstance(appConfig: object): BoxSDKNode;
    CURRENT_USER_ID: string;
    readonly prototype: BoxSDKNode
  }

  interface BoxSDKNode extends EventEmitter {
    config: Config;
    getAppAuthClient(type: string, id?: string, tokenStore?: TokenStore): BoxClient;
    configure(parms: UserConfigurationOptions): void
    getBasicClient(accessToken: string): BoxClient;
    getPersistentClient(tokenInfo: TokenInfo, tokenStore?: TokenStore): BoxClient;
    getAnonymousClient(): BoxClient;
    CURRENT_USER_ID: string;
  }

  const BoxSDKNode: BoxSDKNodeConstructor;
  export default BoxSDKNode;

  export interface UserConfigurationOptions {
    clientID: string;
    clientSecret: string;
    apiRootURL?: string;
    uploadAPIRootURL?: string;
    authorizeRootURL?: string;
    uploadRequestTimeoutMS?: number;
    retryIntervalMS?: number;
    numMaxRetries?: number;
    expiredBufferMS?: number;
    request?: any;
    appAuth?: AppAuthConfig;
  }

  export interface Config {
    [key: string]: any;
    extend(params: UserConfigurationOptions): Config;
  }

  export interface AppAuthConfig {
    keyID: string;
    privateKey: string | Buffer;
    passphrase: string;
    algorithm?: 'RS256' | 'RS384' | 'RS512';
    expirationTime?: number;
    verifyTimestamp?: boolean;
  }

  export interface TokenStore {
    read(callback: (err: Error | undefined, data: any) => void): void;
    write(tokenInfo: TokenInfo, callback: (err: Error | undefined, data: any) => void): void;
    clear(callback: (err: Error | undefined, data: any) => void): void;
  }

  export interface TokenInfo {
  }

  export interface BoxClient {
    setCustomHeader(header: string, value: any): void;
    asUser(userId: string): void;
    asSelf(): void;
    readonly folders: Folders;
    readonly files: Files;
  }

  export interface Folders {
    client: BoxClient;
    get(folderId: string): Promise<Folder>;
    getItems(folderId: string, options?: GetItemsOptions): Promise<Items>;
    create(folderId: string, folderName: string): Promise<Folder>;
  }

  export interface GetItemsOptions {
    fields?: string;
    usemarker?: boolean;
    marker?: string;
    offset?: number;
    sort?: string;
    direction?: 'ASC' | 'DESC';
    limit?: number;
  }

  type FileData = { name: string, size?: number };
  type PreflightResult = { upload_url: string, upload_token: string | null, download_url?: string | null };
  interface UploadSessionInfo {
    total_parts: number;
    part_size: number;
    session_endpoints: {
      list_parts: string;
      commit: string;
      log_event: string;
      upload_part: string;
      status: string;
      abort: string;
    }
    session_expires_at: string;
    id: string;
    type: string;
    num_parts_processed: number;
  }

  class ChunkedUploader extends EventEmitter {
    constructor(client: BoxClient, uploadSessionInfo: UploadSessionInfo, file: string | Buffer | ReadStream, size: number, options?: { parallelism?: number, retryInterval?: number, fileAttributes?: any });
    abort(): Promise<void>;
    start(): Promise<File>;
  }

  export interface Files {
    client: BoxClient;
    uploadFile(folderId: string, fileName: string, content: string | Buffer | ReadStream, options?: any, callback?: Function): Promise<File>;
    uploadNewFileVersion(fileId: string, content: string | Buffer | ReadStream, options?: any, callback?: Function): Promise<File>;
    preflightUploadFile(parentFolderId: string, fileData?: FileData, options?: any, callback?: Function): Promise<PreflightResult>;
    preflightUploadNewFileVersion(fileID: string, fileData?: FileData, options?: any, callback?: Function): Promise<PreflightResult>;
    getChunkedUploader(folderID: string, size: number, name: string, file: string | Buffer | ReadStream, options?: { parallelism?: number, retryInterval?: number, fileAttributes?: any }, callback?: Function): Promise<ChunkedUploader>;
    getNewVersionChunkedUploader(fileID: string, size: number, file: string | Buffer | ReadStream, options?: { parallelism?: number, retryInterval?: number, fileAttributes?: any }, callback?: Function): Promise<ChunkedUploader>;
  }

  interface Object {
    type: string;
    id: string;
  }

  export interface Item extends Object {
    type: 'folder' | 'file';
    name: string;
    sequence_id: string | null;
    etag: string | null;
  }

  export interface Items {
    next_marker?: string;
    total_count?: number;
    offset?: number;
    entries: Item[];
    limit: number;
    order: Order[];
  }

  interface Order {
    by: string;
    direction: 'ASC' | 'DESC';
  }

  type DateTime = string

  interface PathCollection {
    total_count: number;
    entries: Item[];
  }

  interface MiniUser extends Object {
    type: 'user';
    name: string;
    login: string;
  }

  export interface Folder extends MiniFolder {
    created_at: DateTime | null;
    modified_at: DateTime;
    description: string;
    size: number;
    path_collection: PathCollection;
    created_by: MiniUser;
    modified_by: MiniUser;
    trashed_at: DateTime | null;
    purged_at: DateTime | null;
    content_created_at: DateTime | null;
    content_modified_at: DateTime | null;
    expires_at?: DateTime;
    owned_by: MiniUser;
    shared_link: SharedLink | null;
    folder_upload_email: { access: AccessLevel; email: string } | null;
    parent: MiniFolder;
    item_status: ItemStatus;
    item_collection: Items;
    sync_state: SyncState;
    has_collaborations: boolean;
    permissions: Permissions;
    tags: string[];
    can_non_owners_invite: boolean;
    is_externally_owned: boolean;
    is_collaboration_restricted_to_enterprise: boolean;
    allowed_shared_link_access_levels: AccessLevel[];
    allowed_invitee_roles: string[];
    watermark_info: any;
  }

  type SyncState = 'synced' | 'not_synced' | 'partially_synced';
  type ItemStatus = 'active' | 'trashed' | 'deleted';
  type AccessLevel = 'open' | 'company' | 'collaborators';

  interface Permissions {
    can_download: boolean;
    can_upload?: boolean;
    can_rename?: boolean;
    can_delete?: boolean;
    can_share?: boolean;
    can_invite_collaborator?: boolean;
    can_set_share_access?: boolean;
    readonly can_preview?: true;
  }

  export interface MiniFolder extends Item {
    type: 'folder'
  }

  export interface SharedLink {
    readonly url: string;
    readonly download_url: string;
    readonly vanity_url: string;
    access: AccessLevel;
    effective_access: AccessLevel;
    unshared_at: DateTime;
    is_password_enabled: boolean;
    password: string | null;
    permissions: Permissions;
    readonly download_count: number;
    readonly preview_count: number;
  }

  export interface MiniFile extends Item {
    type: 'file';
    sha1: string;
    file_version: MiniFileVersion;
  }

  export interface File extends MiniFile {
  }

  export interface MiniFileVersion extends Object {
    type: 'file_version'
    sha1: string;
  }

  interface RequestObject {
    uri: any;
    method: string;
    headers: {
      [key: string]: any;
    };
  }
  
  interface ResponseObject {
    request: RequestObject;
    statusCode: number;
    headers: {
      [key: string]: any;
    };
    body: ResponseBody | Buffer | string;
  }
  
  interface ResponseBody {
    [key: string]: any;
    [key: number]: any;
  }
  
  interface ErrorResponseObject extends ResponseObject {
    body: ErrorResponseBody;
  }
  
  interface ErrorResponseBody extends ResponseBody {
    type: 'error';
    status: number;
    code: string;
    context_info?: {
      [key: string]: any;
      [key: number]: any;
      conflicts?: Item[];
    };
    help_url: string;
    message: string;
    request_id: string;
  }
  
  export interface ResponseError extends Error {
    statusCode: number;
    response: ErrorResponseObject;
    request: RequestObject | {};
  }
}
