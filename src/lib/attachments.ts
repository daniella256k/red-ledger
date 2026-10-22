import type { ImageAttachment, ImageAttachmentMimeType } from '../types'

/** The image types attachments may have, with the file extension each is saved under. */
export const IMAGE_EXTENSION_BY_MIME_TYPE: Readonly<Record<ImageAttachmentMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export function isImageMimeType(value: unknown): value is ImageAttachmentMimeType {
  return typeof value === 'string' && Object.hasOwn(IMAGE_EXTENSION_BY_MIME_TYPE, value)
}

/**
 * Saved images are served to the page from the database by the main process,
 * at rl-blob://<sha256>, instead of travelling over IPC as base64 text.
 */
export const ATTACHMENT_URL_SCHEME = 'rl-blob'

/** A stored image's id: the SHA-256 of its bytes, as lowercase hex. */
export const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/

/** Where the page loads an image from, or null when it was removed. */
export function imageSrc(image: ImageAttachment): string | null {
  if (image.dataUrl) return image.dataUrl
  if (image.blobId && BLOB_ID_PATTERN.test(image.blobId)) return `${ATTACHMENT_URL_SCHEME}://${image.blobId}`
  return null
}
