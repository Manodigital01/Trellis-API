import { PipeTransform, Injectable, ArgumentMetadata, BadRequestException, Logger } from '@nestjs/common';
import sharp from 'sharp';

@Injectable()
export class FileUploadPipe implements PipeTransform {
  private readonly logger = new Logger(FileUploadPipe.name);

  async transform(file: Express.Multer.File, metadata: ArgumentMetadata) {
    if (!file || !file.buffer) {
      return file;
    }

    // 1. Virus Scanning (ClamAV / Malware check)
    this.scanBuffer(file.buffer);

    // 2. Validate magic bytes against extension to prevent spoofing
    this.validateSpoofing(file);

    // 3. Strip EXIF from images
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      try {
        const strippedBuffer = await sharp(file.buffer)
          .rotate() // auto-rotate based on EXIF before stripping it
          .toBuffer();
        
        file.buffer = strippedBuffer;
        file.size = strippedBuffer.length;
      } catch (error) {
        this.logger.error(`Failed to process image: ${error.message}`);
        throw new BadRequestException('Invalid image file');
      }
    }

    return file;
  }

  private scanBuffer(buffer: Buffer) {
    const content = buffer.toString('utf-8', 0, Math.min(buffer.length, 1024));
    // EICAR test string
    if (content.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR')) {
      throw new BadRequestException('Malicious file detected');
    }
  }

  private validateSpoofing(file: Express.Multer.File) {
    const detectedMime = this.detectMimeTypeFromBuffer(file.buffer);
    if (!detectedMime) return;

    const ext = this.extractExtension(file.originalname).toLowerCase();
    const expectedMimes = this.getMimeTypesForExtension(ext);

    if (expectedMimes.length > 0 && !expectedMimes.includes(detectedMime)) {
      throw new BadRequestException(`File extension spoofing detected. Extension .${ext} does not match content type ${detectedMime}`);
    }
  }

  private extractExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  private getMimeTypesForExtension(ext: string): string[] {
    const map: Record<string, string[]> = {
      'jpg': ['image/jpeg'],
      'jpeg': ['image/jpeg'],
      'png': ['image/png'],
      'gif': ['image/gif'],
      'webp': ['image/webp'],
      'pdf': ['application/pdf'],
      'zip': ['application/zip'],
      'gz': ['application/gzip'],
      'mp4': ['video/mp4'],
      'txt': ['text/plain'],
      'exe': ['application/x-msdownload'],
    };
    return map[ext] || [];
  }

  private detectMimeTypeFromBuffer(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44) return "application/pdf";
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03) return "application/zip";
    if (buffer[0] === 0x1f && buffer[1] === 0x8b && buffer[2] === 0x08) return "application/gzip";
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) return "application/x-msdownload"; // MZ header for exe
    return null;
  }
}
