import type { MessageKey } from '@/i18n';

/**
 * 会话附件图片的统一入口：长边压到 1120、转 JPEG（透明区域垫白底）。
 * 两个动机——多模态模型的有效分辨率就在这一档，更大的图只是浪费 token；
 * data URL 还要随消息进持久化，原图动辄几 MB 会撞存储配额。
 * 首页 ChatPage 与各页 AI 助手面板（PageAssistant）共用同一条处理路。
 */
export async function normalizeImage(file: File, t: (key: MessageKey) => string): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1120 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('chat.canvasFail'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}
