import { open, realpath } from "node:fs/promises";
import { isAbsolute, extname } from "node:path";
import { createHash } from "node:crypto";

const maximumBytes = 10 * 1024 * 1024;
const extensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
]);

/** Capture a bounded local snapshot so hashing and upload always use the same bytes. */
export async function readImage(file: string) {
  if (typeof file !== "string" || !isAbsolute(file))
    throw new Error("image_path 必须为本地图片的绝对路径。");
  if (!extensions.has(extname(file).toLowerCase()))
    throw new Error("不支持的图片扩展名；请使用 JPG、PNG、WEBP、GIF、BMP、ICO、TIFF 或 HEIC。");
  const imagePath = await realpath(file);
  const handle = await open(imagePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maximumBytes)
      throw new Error("图片必须是非空普通文件，且不能超过10 MiB。");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("读取期间图片发生变化，请重新获取图片后发送。");
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead)
      throw new Error("读取期间图片发生变化，请重新获取图片后发送。");
    return { bytes, path: imagePath, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}
