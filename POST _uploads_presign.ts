// packages/backend/src/modules/storage/presign.service.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

export class StoragePresignService {
  private s3: S3Client;
  private bucketName = process.env.STORAGE_BUCKET_NAME!;
  private cdnBaseUrl = process.env.STORAGE_CDN_URL!; // ej. https://cdn.chapus.es

  constructor() {
    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'eu-south-2', // Región España (Aragón)
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY!,
        secretAccessKey: process.env.STORAGE_SECRET_KEY!,
      },
    });
  }

  async createPresignedUploadUrl(params: {
    userId: string;
    fileName: string;
    contentType: string;
    fileSizeBytes: number;
    purpose: 'ISSUE_ATTACHMENT' | 'COMPLETION_PROOF' | 'AVATAR';
  }) {
    const ext = ALLOWED_MIME_TYPES[params.contentType];
    if (!ext) {
      throw new Error('UNSUPPORTED_MEDIA_TYPE');
    }

    if (params.fileSizeBytes > 15 * 1024 * 1024) {
      throw new Error('FILE_TOO_LARGE_MAX_15MB');
    }

    const now = new Date();
    const folder = params.purpose.toLowerCase();
    const fileKey = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${params.userId}-${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
      ContentType: params.contentType,
      ContentLength: params.fileSizeBytes, // Bloquea en S3 si el cliente intenta subir un archivo de distinto tamaño
      Metadata: {
        uploadedBy: params.userId,
        purpose: params.purpose,
      },
    });

    const expiresInSeconds = 300; // 5 minutos para completar el PUT desde el móvil
    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });

    return {
      uploadUrl,
      publicFileUrl: `${this.cdnBaseUrl}/${fileKey}`,
      fileKey,
      expiresInSeconds,
      requiredHeaders: {
        'Content-Type': params.contentType,
      },
    };
  }
}