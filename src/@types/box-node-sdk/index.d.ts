declare module 'box-node-sdk' {
  import { ReadStream } from 'fs';

  export function getBasicClient(token: string): BoxClient;

  export function getPreconfiguredInstance(appConfig: object): BoxSDKNode;

  export interface BoxSDKNode {
    getAppAuthClient(type: string, id?: string, tokenStore?: TokenStore): BoxClient;
  }

  export interface TokenStore {
    read(callback: (err: Error | undefined, data: any) => void): void;
    write(tokenInfo: TokenInfo, callback: (err: Error | undefined, data: any) => void): void;
    clear(callback: (err: Error | undefined, data: any) => void): void;
  }

  export interface TokenInfo {}

  export interface BoxClient {
    asUser(userId: string): void;
    asSelf(): void;
    readonly folders: Folders;
    readonly files: Files;
  }

  export interface Folders {
    get(folderId: string): Promise<Folder>;
    getItems(folderId: string): Promise<Items>;
    create(folderId: string, folderName: string): Promise<Folder>;
  }

  export interface Files {
    uploadFile(folderId: string, fileName: string, stream: ReadStream): Promise<File>;
    uploadNewFileVersion(fileId: string, stream: ReadStream): Promise<File>;
  }

  export interface Object {
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
    total_count: number;
    entries: Item[];
    offset: number;
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
    access : AccessLevel;
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
}
