import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { api } from './api';

const MAX_SIDE = 1600;
const MAX_BYTES = 15 * 1024 * 1024; // límite de PresignUploadRequest.fileSizeBytes

export interface LocalPhoto {
  uri: string;
  width: number;
  height: number;
}

/** Redimensiona a ≤1600 px y recomprime a JPEG: ~300 KB por foto en lugar de 4-8 MB. */
async function compress({ uri, width, height }: LocalPhoto): Promise<Blob> {
  const ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > MAX_SIDE) {
    ctx.resize(width >= height ? { width: MAX_SIDE } : { height: MAX_SIDE });
  }
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
  return (await fetch(saved.uri)).blob();
}

/**
 * Sube cada foto directamente a S3/GCS con su URL firmada y devuelve las URLs de CDN
 * para `photoUrls`. La firma incluye ContentLength, así que se pide con el tamaño exacto
 * del archivo YA comprimido y se envían tal cual los `requiredHeaders`.
 */
export async function uploadPhotos(photos: LocalPhoto[]): Promise<string[]> {
  return Promise.all(
    photos.map(async (photo, i) => {
      const body = await compress(photo);
      if (body.size > MAX_BYTES) throw new Error('FILE_TOO_LARGE_MAX_15MB');
      const slot = await api.presignUpload({
        fileName: `incidencia_${Date.now()}_${i + 1}.jpg`,
        contentType: 'image/jpeg',
        fileSizeBytes: body.size,
        purpose: 'ISSUE_ATTACHMENT',
      });
      const put = await fetch(slot.uploadUrl, { method: 'PUT', headers: slot.requiredHeaders, body });
      if (!put.ok) throw new Error(`upload ${put.status}`);
      return slot.publicFileUrl;
    }),
  );
}
