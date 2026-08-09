/**
 * Formats the OpenAI audio API accepts. Shared by every OpenAI-compatible
 * provider; a backend with a different matrix can override supportsMimetype().
 */
export const SUPPORTED_MIMETYPES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/webm',
  'audio/ogg',
]);

export function isSupportedMimetype(mimetype: string): boolean {
  return SUPPORTED_MIMETYPES.has(mimetype);
}
