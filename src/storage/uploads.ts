import type {} from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import sharp, { type Sharp } from 'sharp';

import { AppError } from '../errors/app-error.js';

export interface ProcessedFile {
  body: Buffer;
  contentType: string;
  extension: string;
}

const acceptedImageFormats = new Set(['jpeg', 'png', 'webp']);
// Phone cameras top out well below this. Larger images are rejected before
// decoding so one upload cannot exhaust the server's memory.
const maximumInputPixels = 40_000_000;

// Reads exactly one file from a multipart/form-data request.
export async function readSingleUpload(
  request: FastifyRequest,
  fieldName: string,
  maximumBytes: number,
): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw new AppError(
      415,
      'UPLOAD_REQUIRED',
      `Send the file as multipart/form-data in the "${fieldName}" field.`,
    );
  }
  const file = await request.file({ limits: { fileSize: maximumBytes } });
  if (!file || file.fieldname !== fieldName) {
    throw new AppError(
      400,
      'UPLOAD_MISSING',
      `Send the file in the "${fieldName}" field.`,
    );
  }
  try {
    return await file.toBuffer();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      throw new AppError(
        413,
        'UPLOAD_TOO_LARGE',
        `The file must be ${maximumBytes / (1024 * 1024)} MB or smaller.`,
      );
    }
    throw error;
  }
}

async function decodeImage(body: Buffer) {
  try {
    const image = sharp(body, {
      limitInputPixels: maximumInputPixels,
      failOn: 'error',
    });
    const metadata = await image.metadata();
    return metadata.format && acceptedImageFormats.has(metadata.format)
      ? image
      : null;
  } catch {
    return null;
  }
}

// Re-encoding drops all metadata, including the GPS location phones embed in
// photos, and anything else hidden in the original file.
async function reencode(
  body: Buffer,
  transform: (image: Sharp) => Sharp,
): Promise<Buffer | null> {
  const image = await decodeImage(body);
  if (!image) return null;
  try {
    return await transform(image.rotate()).webp({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}

export async function processProfilePhoto(
  body: Buffer,
): Promise<ProcessedFile> {
  const output = await reencode(body, (image) =>
    image.resize(512, 512, { fit: 'cover' }),
  );
  if (!output) {
    throw new AppError(
      415,
      'UNSUPPORTED_IMAGE',
      'Upload a JPEG, PNG, or WebP image.',
    );
  }
  return { body: output, contentType: 'image/webp', extension: 'webp' };
}

export async function processReceipt(body: Buffer): Promise<ProcessedFile> {
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { body, contentType: 'application/pdf', extension: 'pdf' };
  }
  const output = await reencode(body, (image) =>
    image.resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }),
  );
  if (!output) {
    throw new AppError(
      415,
      'UNSUPPORTED_RECEIPT',
      'Upload a JPEG, PNG, or WebP image, or a PDF.',
    );
  }
  return { body: output, contentType: 'image/webp', extension: 'webp' };
}
