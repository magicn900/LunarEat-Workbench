export const pdfImageOrigin = 'https://pdf-images.invalid';
export type PdfImageResource = { mime: string; bytes: Buffer };
export type PdfImageResources = ReadonlyMap<string, PdfImageResource>;
