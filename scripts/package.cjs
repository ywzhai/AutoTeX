"use strict";
// Small dependency-free ZIP writer so packaging does not need a build tool.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const extensionDir = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const required = new Set(["manifest.json", manifest.action.default_popup]);
for (const entry of manifest.content_scripts) for (const file of [...entry.js, ...(entry.css || [])]) required.add(file);
for (const file of required) if (!fs.existsSync(path.join(extensionDir, file))) throw new Error(`Missing extension file: ${file}`);

const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
const entries = fs.readdirSync(extensionDir).filter((name) => fs.statSync(path.join(extensionDir, name)).isFile())
  .sort().map((name) => ({ name, bytes: fs.readFileSync(path.join(extensionDir, name)) }));
entries.push({ name: "INSTALL.txt", bytes: Buffer.from(
  "AutoTeX\r\n\r\n" +
  "1. Extract this ZIP into a permanent folder.\r\n" +
  "2. Open chrome://extensions and enable Developer mode.\r\n" +
  "3. Click Load unpacked and select this extracted folder (contains manifest.json).\r\n" +
  "4. Reload Overleaf and use the Code Editor.\r\n\r\n" +
  "Type within LaTeX math to reuse document expressions, continue math patterns,\r\n" +
  "or extend a sequence such as x_1,x_2. Grey text previews the continuation.\r\n" +
  "Tab accepts. Esc dismisses. Undo removes acceptance.\r\n\r\n" +
  "The extension popup controls features and the default final index.\r\n" +
  "Suggestions run locally. Document text is never uploaded. No API key needed.\r\n" +
  "The included model.js identifies whether trained corpus data is installed.\r\n" +
  "Unofficial extension; not affiliated with Overleaf.\r\n", "utf8") });
const localRecords = [], centralRecords = [];
let offset = 0;
for (const { name, bytes } of entries) {
  const filename = Buffer.from(name, "utf8");
  const compressed = zlib.deflateRawSync(bytes);
  const checksum = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); header.copy(central, 6, 4, 30);
  central.writeUInt32LE(offset, 42);
  localRecords.push(header, filename, compressed);
  centralRecords.push(central, filename);
  offset += header.length + filename.length + compressed.length;
}
const central = Buffer.concat(centralRecords);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const target = path.join(root, "dist", "autotex.zip");
fs.writeFileSync(target, Buffer.concat([...localRecords, central, end]));
console.log(`Packaged ${entries.length} files: ${target}`);
