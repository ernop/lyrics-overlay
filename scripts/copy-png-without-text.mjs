// Copies a PNG without its text and time chunks. GNOME's screenshots record
// when they were taken, so a refreshed README picture would differ from the
// last one even when nothing in it changed.
//
//   node scripts/copy-png-without-text.mjs FROM TO
import fs from 'node:fs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DROPPED = new Set(['tEXt', 'iTXt', 'zTXt', 'tIME']);

const [from, to] = process.argv.slice(2);
const data = fs.readFileSync(from);
if (!data.subarray(0, SIGNATURE.length).equals(SIGNATURE))
    throw new Error(`${from} is not a PNG`);
const kept = [SIGNATURE];
let offset = SIGNATURE.length;
while (offset < data.length) {
    // Length, type, data, CRC.
    const end = offset + 12 + data.readUInt32BE(offset);
    if (!DROPPED.has(data.toString('latin1', offset + 4, offset + 8)))
        kept.push(data.subarray(offset, end));
    offset = end;
}
if (offset !== data.length)
    throw new Error(`${from} ends inside a chunk`);
fs.writeFileSync(to, Buffer.concat(kept));
