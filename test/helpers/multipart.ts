import { randomUUID } from 'node:crypto';

// Builds a multipart/form-data body with one file part for app.inject().
export function multipartFile(
  field: string,
  content: Buffer,
  contentType: string,
  filename = 'upload',
) {
  const boundary = `----travelbuddy${randomUUID()}`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
