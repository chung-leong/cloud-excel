import Chai, { expect } from 'chai';
import ChaiAsPromised from 'chai-as-promised';
import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import nodeFetch from 'node-fetch';

Chai.use(ChaiAsPromised);

import {
  readUInt16LE,
  readUInt32LE,
  decompressData,
} from '../src/zip-file.js';
import {  
  ZipFile,
} from '../src/zip-file.js';

describe('Zip functions', function() {
  const response = {}; 
  const server = createServer((req, res) => {
    const { url } = req;
    const root = resolve(`./files`);
    const path = root + url;
    let status = 404, headers = {}, body;
    try {
      const data = readFileSync(path);
      const { mtime } = statSync(path);
      const range = req.headers.range;
      const hash = createHash('sha1');
      hash.update(data);
      const etag = hash.digest('hex') + (response.etagSuffix ?? '');
      const m = /bytes=(\d+)-(\d+)/.exec(range) ?? /bytes=-(\d+)/.exec(range);
      if (!response.omitEtag) {
        headers['etag'] = etag;
      }
      const lastModified = new Date(response.lastModifiedOverride ?? mtime).toString();
      if (!response.omitLastModified) {
        headers['last-modified'] = lastModified;
      }
      if(m) {
        const ifMatch = req.headers['if-match'];
        if (ifMatch && ifMatch !== etag) {
          status = 412;
          throw new Error(`ETag mismatch: ${ifMatch} !== ${etag}`);
        }
        const ifModifiedSince = req.headers['if-modified-since'];
        if (ifModifiedSince && ifModifiedSince !== lastModified) {
          status = 412;
          throw new Error(`File modified: ${lastModified}`);
        }
        status = 206;
        if (m.length === 3) {
          const offset = parseInt(m[1]), last = parseInt(m[2]) + 1;
          body = data.subarray(offset, last);
        } else if (m.length === 2) {
          const offset = -parseInt(m[1]);
          body = data.subarray(offset);  
        }
      } else {
        status = 200;
        body = data;  
      }
    } catch (err) {
      body = err.message;
    }
    if (response.truncateBody) {
      body = body.subarray(0, response.truncateBody);
    }
    res.writeHead(status, headers);
    res.end(body);
  });
  before(function(done) {
    server.listen(0, done);
    global.fetch = async (path, options) => {
      const { port } = server.address();
      const url = new URL(path, `http://localhost:${port}/`);
      const res = await nodeFetch(url, options);
      // polyfill getReader()
      attachGetReader(res.body);
      return res;
    };   
  })
  after(function(done) {
    server.close(done);
  })
  afterEach(function() {
    for (const key in response) {
      delete response[key]
    }
  })
  describe('#readUInt16LE', function() {
    it('should throw if index lies outside of array', function() {
      const a = new Uint8Array([ 1, 2, 3 ]);
      expect(() => readUInt16LE(a, 2)).to.throw();
    })
  })
  describe('#readUInt32LE', function() {
    it('should throw if index lies outside of array', function() {
      const a = new Uint8Array([ 1, 2, 3 ]);
      expect(() => readUInt32LE(a, 2)).to.throw();
    })
  })
  describe('#decompressData', function() {
    it('should throw if the input is invalid', async function() {
      const promise = decompressData(false, 8);
      await expect(promise).to.eventually.be.rejected;
    })
    it('should throw if the data is invalid', async function() {
      const promise = decompressData([ new Uint8Array(0) ], 8);
      await expect(promise).to.eventually.be.rejected;
    })
    it('should throw if the data is corrupted', async function() {
      const data = new Uint8Array([ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const promise = decompressData(data, 8);
      await expect(promise).to.eventually.be.rejected;
    })
  })
  describe('ZipFile', function() {
    describe('#open', function() {
      it('should load the central directory', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const cd = zip.centralDirectory;
        await zip.close();
        expect(cd[3]).to.have.property('name', 'three-files/malgorzata-socha.jpg');
        expect(cd[1]).to.have.property('uncompressedSize', 32474);
      })
      it('should find the central directory when there is 1 extra byte', async function() {
        const url = 'three-files-x1.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const cd = zip.centralDirectory;
        await zip.close();
        expect(cd[3]).to.have.property('name', 'three-files/malgorzata-socha.jpg');
        expect(cd[1]).to.have.property('uncompressedSize', 32474);
      })
      it('should find the central directory when there is 2 extra bytes', async function() {
        const url = 'three-files-x2.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const cd = zip.centralDirectory;
        await zip.close();
        expect(cd[3]).to.have.property('name', 'three-files/malgorzata-socha.jpg');
        expect(cd[1]).to.have.property('uncompressedSize', 32474);
      })
      it('should find the central directory when there is 3 extra bytes', async function() {
        const url = 'three-files-x3.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const cd = zip.centralDirectory;
        await zip.close();
        expect(cd[3]).to.have.property('name', 'three-files/malgorzata-socha.jpg');
        expect(cd[1]).to.have.property('uncompressedSize', 32474);
      })
      it('should find the central directory when there is 5 extra bytes', async function() {
        const url = 'three-files-x5.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const cd = zip.centralDirectory;
        await zip.close();
        expect(cd[3]).to.have.property('name', 'three-files/malgorzata-socha.jpg');
        expect(cd[1]).to.have.property('uncompressedSize', 32474);
      })
      it('should throw when eof-of-central-directory record cannot be found', async function() {
        const url = 'three-files-bad-eocd.zip';
        const zip = new ZipFile(url);
        const promise = zip.open();
        await expect(promise).to.eventually.be.rejected;
      })
      it('should throw when central-directory record is corrupted', async function() {
        const url = 'three-files-bad-cdh.zip';
        const zip = new ZipFile(url);
        const promise = zip.open();
        await expect(promise).to.eventually.be.rejected;
      })
    })
    describe('#getFiles', function() {
      it('should return list of files', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const list = zip.getFiles();
        await zip.close();
        expect(list).to.have.lengthOf(3);
      })
    })
    describe('#extractFile', function() {
      it('should throw if a file has not been opened yet', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        const promise = zip.extractFile('three-files/LICENSE.txt');
        await expect(promise).to.eventually.be.rejected;
      })
      it('should throw if a local header is corrupted', async function() {
        const url = 'three-files-bad-lh.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const promise = zip.extractFile('three-files/LICENSE.txt');
        await expect(promise).to.eventually.be.rejected;
        await zip.close();
      })
      it('should throw if a compressed size in CD is corrupted', async function() {
        const url = 'three-files-bad-size.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const promise = zip.extractFile('three-files/LICENSE.txt');
        await expect(promise).to.eventually.be.rejected;
        await zip.close();
      })
    })
    describe('#extractTextFile', function() {
      it('should extract a text file', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const text = await zip.extractTextFile('three-files/LICENSE.txt');
        await zip.close();
        expect(text).to.include('GNU');
      })
      it('should be able to retrieve file after modification', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        await zip.open();
        // force etag change
        response.etagSuffix = '/123';
        const text = await zip.extractTextFile('three-files/LICENSE.txt');
        await zip.close();
        expect(text).to.include('GNU');
      })
      it('should work when server does not return etag', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        response.omitEtag = true;
        await zip.open();
        const text = await zip.extractTextFile('three-files/LICENSE.txt');
        await zip.close();
        expect(text).to.include('GNU');
      })
      it('should throw when there is a size mismatch', async function() {
        const url = 'three-files.zip';
        const zip = new ZipFile(url);
        await zip.open();
        response.truncateBody = -100;
        const promise = zip.extractTextFile('three-files/LICENSE.txt');
        await zip.close();
        await expect(promise).to.be.eventually.rejected;
      })
      it('should extract a text file with Unicode name', async function() {
        const url = 'unicode.zip';
        const zip = new ZipFile(url);
        await zip.open();
        const text = await zip.extractTextFile('szczęście.txt');
        await zip.close();
        expect(text).to.include('szczęście');
      })
      it('should throw when file is not in archive', async function() {
        const url = 'unicode.zip';
        const zip = new ZipFile(url);
        await zip.open();
        await expect(zip.extractTextFile('cześć.txt')).to.eventually.be.rejected;
        await zip.close();
      })
    })
  })
})

function attachGetReader(stream) {
  stream.getReader = function() {
    const f = this[Symbol.asyncIterator];
    const iterator = f.call(this);
    return {
      read: () => iterator.next(),
    };
  };
}

function resolve(path) {
  return (new URL(path, import.meta.url)).pathname;
}
