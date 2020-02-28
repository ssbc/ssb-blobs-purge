# ssb-blobs-purge

SSB plugin to automatically remove old and large blobs.

Works by recursively traversing the blobs folder, and prioritizing deletes of blobs that are old (large creation timestamp) and large (large file size), or both. Does not delete blobs that your own feed posted (or mentioned first). Stops deletion once the `storageLimit` target is reached.

## Usage

**Prerequisites:**

- **Node.js 6.5** or higher
- `secret-stack@^6.2.0`
- `ssb-blobs` installed
- `ssb-backlinks` installed

```
npm install --save ssb-blobs-purge
```

Add this plugin to ssb-server like this:

```diff
 var createSsbServer = require('ssb-server')
     .use(require('ssb-onion'))
     .use(require('ssb-unix-socket'))
     .use(require('ssb-no-auth'))
     .use(require('ssb-plugins'))
     .use(require('ssb-master'))
     .use(require('ssb-conn'))
     .use(require('ssb-blobs'))
     .use(require('ssb-backlinks'))
+    .use(require('ssb-blobs-purge'))
     .use(require('ssb-replicate'))
     .use(require('ssb-friends'))
     // ...
```

Now you should be able to access the following muxrpc APIs under `ssb.blobsPurge.*`:

| API | Type | Description |
|-----|------|-------------|
| **`start(opts?)`** | `sync` | Triggers the start of purge task. Optionally, you may pass an object with two fields: `cpuMax` and `storageLimit` |
| **`stop()`** | `sync` | Stops the purge task if it is currently active. |
| **`changes()`** | `source` | A pull-stream that emits events notifying of progress done by the purge task, these events are objects as described below. |

A `changes()` event object is one these three possibile types:

- `{ event: 'deleted', blobId }`
- `{ event: 'paused' }`
- `{ event: 'resumed' }`

## Setting the parameters

There are two parameters you can tweak with this module:

- `cpuMax`: **(default 50)** a number between `0` and `100` that represents a threshold for CPU usage; when your device's CPU usage is *below* this percentual number, the purge task will run, otherwise it will be paused
- `storageLimit`: **(default 10 gigabytes)** a number (in bytes) that represents the desired maximum storage for blobs; when your blobs folder is *larger* than this number, the purge task will run, otherwise it will be paused

There are two ways you can set these parameters:

**(1) In the SSB config object**:

```diff
 {
   path: ssbPath,
   keys: keys,
   port: 8008,
   blobs: {
     sympathy: 2
   },
+  blobsPurge: {
+    cpuMax: 30,
+    storageLimit: 2000000000
+  },
   conn: {
     autostart: false
   }
 }
```

**(2) When calling the `start` function**, note that this is **ignored** in case you supply (1) above:

```javascript
ssb.blobsPurge.start({ cpuMax: 30, storageLimit: 2000000000 })
```

## License

MIT
