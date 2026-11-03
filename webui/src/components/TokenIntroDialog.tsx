import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useSettings } from '@/settings/SettingsContext';

/** 「已提示过」标记（非敏感，落 localStorage；token 本身永不落浏览器） */
const INTRO_KEY = 'swift-webui.token-intro';

/** ModelScope 个人访问令牌的获取页 */
const TOKEN_URL = 'https://modelscope.cn/my/myaccesstoken';

/**
 * 展览模式的令牌引导（本地模式走 TourDialog 导览、不弹这个）：token 为空
 * 且未提示过时弹出——说清 PAT 的用途（research 对话的默认模型、tinker
 * 服务）、给获取入口、并明确「不填也完全可用」。仅第一次；可跳过；
 * 后续随时在设置页配置。
 */
export function TokenIntroDialog() {
  const { t } = useT();
  const { settings, update, loaded, mode } = useSettings();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (mode !== 'expo' || !loaded || settings.msToken) return;
    try {
      if (localStorage.getItem(INTRO_KEY)) return;
    } catch {
      /* 存储受限：本次会话内不再弹（内存标记由 open 状态自身承担） */
    }
    setOpen(true);
  }, [mode, loaded, settings.msToken]);

  const close = () => {
    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      /* 同上 */
    }
    setOpen(false);
  };

  const save = () => {
    const v = value.trim();
    if (!v) {
      close();
      return;
    }
    update('msToken', v);
    toast.success(t('token.introSaved'));
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={15} className="flex-none" />
            {t('token.introTitle')}
          </DialogTitle>
          <DialogDescription>{t('token.introDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('token.introPlaceholder')}
            type="password"
          />
          <a
            href={TOKEN_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
          >
            {t('token.introGet')}
            <ExternalLink size={11} className="flex-none" />
          </a>
          <p className="text-muted-foreground text-[12px] leading-[18px]">{t('token.introOptional')}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={close}>
            {t('token.introSkip')}
          </Button>
          <Button size="sm" onClick={save}>
            {t('token.introSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
