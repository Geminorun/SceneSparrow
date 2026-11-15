// Self-authored minimal fixtures (CC0). No third-party document content.
import { deflateRawSync } from "node:zlib";
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
export function zip(entries) {
  let offset = 0;
  const locals = [],
    central = [];
  for (const [name, data] of Object.entries(entries)) {
    const plain = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = deflateRawSync(plain);
    const filename = Buffer.from(name);
    const crc = crc32(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(plain.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(
    central.reduce((n, b) => n + b.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
export function docx(body, extra = {}) {
  return zip({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml":
      typeof body === "string"
        ? `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
        : body,
    ...extra,
  });
}
export function pdf(pages = [{ text: "First page" }], encrypted = false) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids = [];
  for (const page of pages) {
    const pageId = objects.length + 1,
      contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const imageId = page.image ? contentId + 1 : null;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> ${imageId ? `/XObject << /Im0 ${imageId} 0 R >>` : ""} >> /Contents ${contentId} 0 R >>`,
    );
    const stream = page.text
      ? `BT /F1 12 Tf 20 250 Td (${page.text.replace(/[()\\]/g, "\\$&")}) Tj ET`
      : page.image
        ? "q 100 0 0 100 20 20 cm /Im0 Do Q"
        : "";
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
    if (imageId)
      objects.push(
        "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream",
      );
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  const encrypt = encrypted
    ? objects.push(
        `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"01".repeat(32)}> /P -4 >>`,
      )
    : null;
  let result = "%PDF-1.4\n",
    offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypt ? `/Encrypt ${encrypt} 0 R /ID [<${"02".repeat(16)}> <${"02".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
