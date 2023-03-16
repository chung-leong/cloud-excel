import { inflateRaw } from 'pako';

export class ZipFile {
  constructor(url) {
    this.url = url;
    this.etag = null;
    this.lastModified = null;
    this.centralDirectory = null;
    this.centralDirectoryOffset;
  }

  async open() {    
    this.centralDirectory = await this.loadCentralDirectory();
  }

  async close() {
  }

  getFiles() {
    const names = this.centralDirectory.map(r => r.name);
    return names.filter(n => !n.endsWith('/'));
  }

  async retrieveFile(name) {
    if (!this.centralDirectory) {
      throw new Error('File has not been opened yet');
    }
    const record = this.centralDirectory.find(r => r.name === name);
    if (!record) {
      throw new Error(`Cannot find file in archive: ${name}`);
    }
    const { localHeaderOffset, compressedSize, compression } = record;
    // look for the following file
    let next;
    for (const r of this.centralDirectory) {
      if (r.localHeaderOffset > localHeaderOffset) {
        if (!next || r.localHeaderOffset < next.localHeaderOffset) {
          next = r;
        }
      }
    }
    // fetch both the header and data (and possible the data descriptor)
    const endOffset = (next) ? next.localHeaderOffset : this.centralDirectoryOffset;
    const combinedSize = endOffset - localHeaderOffset;
    const combined = await this.fetch(combinedSize, localHeaderOffset);
    const header = combined.subarray(0, 30);
    const signature = readUInt32LE(header);
    if (signature !== 0x04034b50) {
      throw new Error('Invalid file header');
    }
    const nameLength = readUInt16LE(header, 26);
    const extraLength = readUInt16LE(header, 28);
    const dataOffset = 30 + nameLength + extraLength;
    const data = combined.subarray(dataOffset, dataOffset + compressedSize);
    if (data.length !== compressedSize) {
      throw new Error('Cannot read the correct number of bytes');
    }
    const uncompressedData = await decompressData(data, compression);
    return uncompressedData;
  }

  async extractFile(name) {
    for (let attempt = 1;; attempt++) {
      try {
        const data = await this.retrieveFile(name);
        return data;
      } catch (err) {
        if (err instanceof HTTPError && err.status === 412) {
          this.etag = null;
          this.lastModified = null;
          this.centralDirectory = null;
          if (attempt < 3) {
            this.centralDirectory = await this.loadCentralDirectory();
            continue;
          }
        }
        throw err;
      }  
      /* c8 ignore next */
    }    
  }

  async extractTextFile(name, encoding = 'utf8') {
    const buffer = await this.extractFile(name);
    const decoder = new TextDecoder(encoding);
    return decoder.decode(buffer);
  }

  async findCentralDirectory() {
    const headerSize = 22;
    const maxCommentLength = 16;
    const offsetLimit = -headerSize - maxCommentLength;
    let offset = -headerSize;
    let found = false;
    let header;
    while (!found && offset >= offsetLimit) {
      header = await this.fetch(headerSize, offset);
      const signature = readUInt32LE(header);
      if (signature === 0x06054b50) {
        found = true;
      } else {
        // the byte sequence is 0x50 0x4b 0x05 0x06
        const firstByte = signature & 0x000000FF;
        switch (firstByte) {
          case 0x06: offset -= 3; break;
          case 0x05: offset -= 2; break;
          case 0x4b: offset -= 1; break;
          default: offset -= 4;
        }
      }
    }
    if (found) {
      const count = readUInt16LE(header, 10);
      const size = readUInt32LE(header, 12);
      const offset = readUInt32LE(header, 16);
      return { count, size, offset };
    } else {
      throw new Error('Unable to find EOCD record');
    }
  }

  async loadCentralDirectory() {
    const records = [];
    const { size, offset } = await this.findCentralDirectory();
    const buffer = await this.fetch(size, offset);
    let index = 0;
    while (index < size) {
      const signature = readUInt32LE(buffer, index);
      if (signature !== 0x02014b50) {
        throw new Error('Invalid CD record');
      }
      const nameLength = readUInt16LE(buffer, index + 28);
      const extraLength = readUInt16LE(buffer, index + 30);
      const commentLength = readUInt16LE(buffer, index + 32)
      const headerSize = 46 + nameLength + extraLength + commentLength;
      const header = buffer.subarray(index, index + headerSize);
      const flags = readUInt16LE(header, 8);
      const compression = readUInt16LE(header, 10);
      const compressedSize = readUInt32LE(header, 20);
      const uncompressedSize = readUInt32LE(header, 24);
      const name = extractName(header, 46, nameLength, flags);
      const localHeaderOffset = readUInt32LE(header, 42);
      records.push({
        name,
        nameLength,
        compression,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      index += headerSize;
    }
    this.centralDirectoryOffset = offset;
    return records;
  }

  async fetch(size, offset) {
    const headers = { 'accept-encoding': 'identity' };
    if (offset < 0) {
      headers.range = `bytes=${offset}`;
    } else {
      headers.range = `bytes=${offset}-${offset + size - 1}`;
    }
    if (this.etag) {
      headers['if-match'] = this.etag;
    } else if (this.lastModified) {
      headers['if-unmodified-since'] = this.lastModified;
    }
    const res = await fetch(this.url, { headers });
    if (res.status !== 206) {
      throw new HTTPError(res);
    }
    this.etag = res.headers.get('etag');
    this.lastModified = res.headers.get('last-modified');
    const buffer = await res.arrayBuffer();
    let chunk = new Uint8Array(buffer);
    if (chunk.length !== size) {
      if (chunk.length > size) {
        chunk = chunk.subarray(0, size);
      } else {
        throw new Error('Size mismatch');
      }
    }
    return chunk;  
  }
}

export function readUInt16LE(buffer, offset = 0) {
  checkArrayBound(buffer, offset, 2);
  return buffer[offset] | buffer[offset + 1] << 8;
}

export function readUInt32LE(buffer, offset = 0) {
  checkArrayBound(buffer, offset, 4);
  return buffer[offset] | buffer[offset + 1] << 8 | buffer[offset + 2] << 16 | buffer[offset + 3] << 24;
}

function checkArrayBound(buffer, offset, length) {
  if (buffer.length < offset + length) {
    throw new RangeError(`Attempt to access memory outside buffer bounds`);
  }
}

function extractName(header, index, length, flags) {
  const raw = header.subarray(index, index + length);
  const encoding = (flags & 0x0800) ? 'utf8' : 'ascii';
  const decoder = new TextDecoder(encoding);
  return decoder.decode(raw);
}

export async function decompressData(buffer, type) {
  if (type === 8) {
    if (buffer.length === undefined) {
      throw new TypeError('Invalid input');
    }
    try {
      buffer = inflateRaw(buffer);
      if (buffer === undefined) {
        throw new Error('Decompression failure');
      }
    } catch (err) {
      if (typeof(err) === 'string') {
        err = new Error(err);
      }
      throw err;
    }
  }
  return buffer;
}

class HTTPError extends Error { 
  constructor(res) {
    super(`HTTP ${res.status} - ${res.statusText}`);
    this.status = res.status;
    this.statusText = res.statusText;
  }
}
