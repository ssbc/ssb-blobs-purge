import {plugin, muxrpc} from 'secret-stack-decorators';
import {BlobId, Msg} from 'ssb-typescript';
import {BlobWithMeta, Callback, SSBConfig, SSB, ChangesEvent} from './types';
import path = require('path');
import run = require('promisify-tuple');
const Notify = require('pull-notify');
const pull = require('pull-stream');
const drainGently = require('pull-drain-gently');
const trammel = require('trammel');
const debug = require('debug')('ssb:blobs-purge');

/**
 * Heuristic function to determine if a blob should be purged.
 * The larger this number is, the more likely it is to be purged.
 */
function heuristic(blob: BlobWithMeta): number {
  // multiplying by 9.7e-4 is approximately dividing by 1024
  const sizeInKb = blob.size * 9.7e-4;

  // multiplying by 1.2e-8 is approximately dividing by (1000 / 60 / 60 / 24);
  const ageInDays = (Date.now() - blob.ts) * 1.2e-8;

  return sizeInKb * ageInDays;
}

/**
 */
function bytesToMB(x: number): number {
  // Multiplying by this is approximately the same as dividing by (1024/1024)
  return Math.round(x * 9.53e-7);
}

const DEFAULT_CPU_MAX = 50; // 50%
const DEFAULT_STORAGE_LIMIT = 10e9; // 10 gigabytes

interface Notifier {
  (ev: ChangesEvent): void;
  listen: () => any;
}

@plugin('1.0.0')
class blobsPurge {
  private readonly ssb: SSB;
  private readonly blobsPath: string;
  private readonly config: SSBConfig;
  private readonly notifier: Notifier;
  private task?: {abort: () => void};
  private cpuMax?: number;
  private storageLimit?: number;

  constructor(ssb: SSB, config: SSBConfig) {
    this.ssb = ssb;
    this.config = config;
    this.blobsPath = path.join(config.path, 'blobs');
    this.notifier = Notify();
    this.init();
  }

  private init() {
    if (!this.ssb.blobs?.ls || !this.ssb.blobs?.rm) {
      throw new Error(
        '"ssb-blobs-purge" is missing required plugin "ssb-blobs"',
      );
    }
    if (!this.ssb.backlinks?.read) {
      throw new Error(
        '"ssb-blobs-purge" is missing required plugin "ssb-backlinks"',
      );
    }
  }

  private isMyBlob = (blobId: BlobId, cb: Callback<boolean>) => {
    let isMine = false;
    pull(
      this.ssb.backlinks!.read({
        query: [{$filter: {dest: blobId}}],
        index: 'DTA', // use asserted timestamps
      }),
      drainGently(
        {ceiling: this.cpuMax, wait: 60},
        (msg: Msg) => {
          if (msg.value.author === this.ssb.id) {
            isMine = true;
            return false; // abort this drainGently
          } else {
            return;
          }
        },
        () => {
          cb(null, isMine);
        },
      ),
    );
  };

  private resume = async () => {
    this.notifier({event: 'resumed'});
    const [e1, used] = await run<number>(trammel)(this.blobsPath, {
      type: 'raw',
    });
    if (e1) throw e1;
    if (used < this.storageLimit!) {
      debug(
        'Blobs directory already fits within our predetermined limit: %dMB < %dMB',
        bytesToMB(used),
        bytesToMB(this.storageLimit!),
      );
      debug('Paused the purge task');
      this.notifier({event: 'paused'});
      this.scheduleNextResume();
      return;
    }

    /**
     * Sensible thresholds for the heuristic, with representative examples:
     * * 1e7 = a 3-year-old 10MB file
     * * 1e6 = a 1-year-old 3MB file
     * * 1e5 = a 3-month-old 1MB file
     * * 1e4 = a 2-week-old 700KB file
     * * 1e3 = a 5-day-old 200KB file
     * * 0 = any file
     */
    const thresholds = pull.values([1e7, 1e6, 1e5, 1e4, 1e3, 0]);

    this.task?.abort();
    this.task = pull(
      thresholds,
      pull.map((threshold: number) =>
        pull(
          this.ssb.blobs!.ls({meta: true}),
          pull.filter((blob: BlobWithMeta) => heuristic(blob) > threshold),
        ),
      ),
      pull.flatten(),
      pull.asyncMap(this.maybeDelete),
      drainGently(
        {ceiling: this.cpuMax, wait: 60},
        (done: boolean) => {
          debug('Paused the purge task');
          this.notifier({event: 'paused'});

          // abort the above pull-stream pipeline when done
          if (done) return false;
          else return;
        },
        this.scheduleNextResume,
      ),
    );
  };

  private maybeDelete = async (blob: BlobWithMeta, cb: Callback<boolean>) => {
    const [e1, used] = await run<number>(trammel)(this.blobsPath, {
      type: 'raw',
    });
    if (e1) return cb(e1);

    if (used > this.storageLimit!) {
      const [e2, isMine] = await run<boolean>(this.isMyBlob)(blob.id);
      if (e2) return cb(e2);
      if (isMine) return cb(null, false);

      debug('Blobs directory occupies too much space: %dMB', bytesToMB(used));
      debug('Delete blob %s which weighs %dMB', blob.id, bytesToMB(blob.size));

      const [e3] = await run<any>(this.ssb.blobs!.rm as any)(blob.id);
      if (e3) return cb(e3);
      this.notifier({event: 'deleted', blobId: blob.id});

      cb(null, false);
    } else {
      debug(
        'Blobs directory now fits within our predetermined limit of %dMB',
        bytesToMB(this.storageLimit!),
      );
      cb(null, true);
    }
  };

  private scheduleNextResume = () => {
    let count = 0;
    this.task?.abort();
    this.task = pull(
      this.ssb.blobs?.changes(),
      pull.drain(() => {
        count += 1;
        if (count < 10) return;

        debug('Resuming the purge task because new blobs have been added');
        this.resume();
        return false; // abort this drain
      }),
    );
  };

  @muxrpc('sync')
  public start = (opts?: SSBConfig['blobsPurge']) => {
    // Set or update the parameters
    this.storageLimit =
      this.config.blobsPurge?.storageLimit ??
      opts?.storageLimit ??
      DEFAULT_STORAGE_LIMIT;
    this.cpuMax =
      this.config.blobsPurge?.cpuMax ?? opts?.cpuMax ?? DEFAULT_CPU_MAX;

    this.task?.abort();
    this.task = void 0;
    debug('Started the purge task ');
    this.resume();
  };

  @muxrpc('sync')
  public stop = () => {
    this.task?.abort();
    this.task = void 0;
    debug('Stopped the purge task ');
  };

  @muxrpc('source')
  public changes = () => {
    return this.notifier.listen();
  };
}

export = blobsPurge;
