/**
 * Размер и формат картинки по её байтам: без библиотек и без доверия расширению.
 * Word понимает PNG, JPEG, GIF и BMP; WebP и SVG без пары «svg+png» он не откроет,
 * поэтому формат определяется по сигнатуре, а не по имени файла.
 */

const EXT_BY_TYPE = { png: 'png', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' };

/** Тип картинки, который Word умеет вставлять, или null. */
export function imageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  return null;
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    /* SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 — все содержат размеры. */
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (!length || length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Размер картинки в пикселях.
 * @returns {{type:string, ext:string, width:number, height:number}|null}
 */
export function imageInfo(buffer) {
  const type = imageType(buffer);
  if (!type) return null;
  let size = null;
  try {
    if (type === 'png' && buffer.length >= 24) {
      size = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    } else if (type === 'jpeg') {
      size = jpegSize(buffer);
    } else if (type === 'gif' && buffer.length >= 10) {
      size = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    } else if (type === 'bmp' && buffer.length >= 26) {
      size = { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
    }
  } catch {
    size = null;
  }
  if (!size || !size.width || !size.height) return null;
  return { type, ext: EXT_BY_TYPE[type], width: size.width, height: size.height };
}

export { EXT_BY_TYPE };
