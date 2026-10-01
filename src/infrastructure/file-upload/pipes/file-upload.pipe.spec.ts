import { FileUploadPipe } from './file-upload.pipe';
import { BadRequestException } from '@nestjs/common';
import * as sharp from 'sharp';

jest.mock('sharp', () => {
  const sharpMock = jest.fn();
  (sharpMock as any).mockImplementation(() => {
    return {
      rotate: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('stripped-image-buffer')),
    };
  });
  return sharpMock;
});

describe('FileUploadPipe', () => {
  let pipe: FileUploadPipe;

  beforeEach(() => {
    pipe = new FileUploadPipe();
    jest.clearAllMocks();
  });

  it('should pass a valid file', async () => {
    const file = {
      originalname: 'test.txt',
      buffer: Buffer.from('hello world'),
      mimetype: 'text/plain',
      size: 11,
    } as Express.Multer.File;

    const result = await pipe.transform(file, {} as any);
    expect(result).toBeDefined();
    expect(result.originalname).toBe('test.txt');
  });

  it('should detect and reject EICAR malware string', async () => {
    const file = {
      originalname: 'virus.txt',
      buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
      mimetype: 'text/plain',
      size: 68,
    } as Express.Multer.File;

    await expect(pipe.transform(file, {} as any)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform(file, {} as any)).rejects.toThrow('Malicious file detected');
  });

  it('should strip EXIF data from JPEG images using sharp', async () => {
    const file = {
      originalname: 'image.jpg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]), // Mock JPEG header
      mimetype: 'image/jpeg',
      size: 5,
    } as Express.Multer.File;

    const result = await pipe.transform(file, {} as any);
    
    expect(sharp).toHaveBeenCalledWith(expect.any(Buffer));
    expect(result.buffer.toString()).toBe('stripped-image-buffer');
  });

  it('should reject spoofed file extensions', async () => {
    // Create a mock PDF buffer (magic bytes %PDF) but named as .jpg
    const file = {
      originalname: 'spoof.jpg',
      buffer: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
      mimetype: 'image/jpeg',
      size: 5,
    } as Express.Multer.File;

    await expect(pipe.transform(file, {} as any)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform(file, {} as any)).rejects.toThrow('File extension spoofing detected. Extension .jpg does not match content type application/pdf');
  });
});
