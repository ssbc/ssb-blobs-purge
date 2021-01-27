import {FeedId, BlobId} from 'ssb-typescript';

export type Callback<T> = (endOrErr: boolean | any, data?: T) => void;

export type BlobWithMeta = {
  id: BlobId;
  size: number;
  ts: number;
};

export type SSB = {
  id: FeedId;
  blobs?: {
    ls: CallableFunction;
    rm: CallableFunction;
    changes: CallableFunction;
  };
  backlinks?: {
    read: CallableFunction;
  };
  db?: {
    query: CallableFunction;
    operators: {
      toPullStream: CallableFunction;
      and: CallableFunction;
      author: CallableFunction;
      fullMentions?: CallableFunction;
    };
  };
};

export type SSBConfig = {
  path: string;
  blobsPurge?: {
    cpuMax?: number;
    storageLimit?: number;
    maxPause?: number;
  };
};

export type ChangesEvent =
  | {
      event: 'deleted';
      blobId: BlobId;
    }
  | {event: 'paused'}
  | {event: 'resumed'};
