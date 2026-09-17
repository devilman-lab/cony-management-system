import { PDFDocument, PageSizes } from 'pdf-lib';

export interface MergeInput {
  /** 表示用。取り込めなかったときの案内に使う。 */
  name: string;
  mime: string;
  content: Buffer;
}

export interface MergeResult {
  pdf: Buffer;
  /** 取り込めなかったもの（Excel や Word など、ブラウザが印刷できない形式）。 */
  skipped: string[];
}

const PDF_TYPES = new Set(['application/pdf']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

function kindOf(input: MergeInput): 'pdf' | 'png' | 'jpg' | null {
  const mime = input.mime.toLowerCase();
  const ext = input.name.toLowerCase().replace(/^.*\./, '');
  if (PDF_TYPES.has(mime) || ext === 'pdf') return 'pdf';
  if (mime === 'image/png' || ext === 'png') return 'png';
  if (IMAGE_TYPES.has(mime) || ext === 'jpg' || ext === 'jpeg') return 'jpg';
  return null;
}

/**
 * 複数の PDF と画像を1つの PDF にまとめる。
 *
 * 出荷確定と同時に「帳票＋添付ファイル」を一度に印刷するため（9/15 ご確認②）。
 * ブラウザが印刷できるのは PDF と画像だけなので、それ以外は取り込まず名前を返す。
 * 画像は A4 に収まるように縮めて1ページに置く。
 */
export async function mergeToPdf(inputs: MergeInput[]): Promise<MergeResult> {
  const out = await PDFDocument.create();
  const skipped: string[] = [];

  for (const input of inputs) {
    const kind = kindOf(input);
    try {
      if (kind === 'pdf') {
        const src = await PDFDocument.load(input.content, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        for (const p of pages) out.addPage(p);
        continue;
      }
      if (kind === 'png' || kind === 'jpg') {
        const image = kind === 'png' ? await out.embedPng(input.content) : await out.embedJpg(input.content);
        const [pw, ph] = PageSizes.A4;
        const margin = 36;
        const scale = Math.min((pw - margin * 2) / image.width, (ph - margin * 2) / image.height, 1);
        const w = image.width * scale;
        const h = image.height * scale;
        const page = out.addPage(PageSizes.A4);
        page.drawImage(image, { x: (pw - w) / 2, y: ph - margin - h, width: w, height: h });
        continue;
      }
      skipped.push(input.name);
    } catch {
      // 壊れたファイルで印刷全体を止めない。名前を返して知らせる。
      skipped.push(input.name);
    }
  }

  return { pdf: Buffer.from(await out.save()), skipped };
}
