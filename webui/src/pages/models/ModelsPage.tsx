import { useCallback, useEffect, useState } from 'react';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { PageHeader } from '@/components/PageHeader';
import { Column } from '@/components/Column';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { deleteModel, listModels, listMsModels, saveModel, type ModelConfig, type MsDefaultModels } from '@/api/models';
import { useT } from '@/i18n';
import { useSettings } from '@/settings/SettingsContext';

/** 表单态：编辑已有模型时 id 只读（id 是主键，改名等于新增一份配置） */
interface Draft extends ModelConfig {
  editing: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  note: '',
  editing: false,
};

/**
 * 模型配置管理。
 *
 * 每条配置就是一个 OpenAI 兼容连接：对话页的下拉列表读这里，
 * key 只存在运行机器的 ~/.swift/models.json（SWIFT_HOME 可改根路径），
 * 前端永远只见到掩码。
 */
export function ModelsPage() {
  const { t } = useT();
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  /*
   * 展览模式：机器侧 models.json 只读（服务端已对写入 403），页面上方再展示
   * 默认模型区。正常模式登录后同样展示（token 在浏览器本地/内存），未登录
   * 不展示——它们经登录会话 token 鉴权，key 不落在任何文件里。
   */
  const { mode, settings } = useSettings();
  const token = settings.msToken;
  const [msModels, setMsModels] = useState<MsDefaultModels | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels(await listModels());
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (token) {
      /* 失败静默：清单是增强不是依赖，页面上只少一个区 */
      listMsModels().then(setMsModels).catch(() => setMsModels(null));
    }
  }, [refresh, mode, token]);

  const submit = async () => {
    if (!draft) return;
    if (!draft.id.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      toast.error(t('md.errRequired'));
      return;
    }
    try {
      await saveModel({ ...draft, id: draft.id.trim() });
      toast.success(t('common.saved', { name: draft.id.trim() }));
      setDraft(null);
      await refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="pb-10">
      <PageHeader
        title={t('md.title')}
        desc={
          mode === 'expo'
            ? t('md.descExpo')
            : t('md.descNormal')
        }
        extra={
          mode !== 'expo' && (
            <Button size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus /> {t('md.add')}
            </Button>
          )
        }
      />

      <Column>
        {/*
         * 登录后的默认模型区：对话页首页下拉里排最前的同三条。鉴权走当前
         * 登录会话的 token（x-swift-api-key 头），所以这里没有「配置 key」一说。
         */}
        {token &&
          msModels?.models.map((m) => (
            <div
              key={m.model}
              className="border-border bg-card flex items-center gap-3 rounded-xl border p-4"
            >
              <span className="bg-primary/10 text-primary flex size-8 flex-none items-center justify-center rounded-lg">
                <Bot size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-foreground flex items-baseline gap-2 truncate text-sm font-medium">
                  {m.label}
                  <span className="text-primary flex-none text-[11px] font-normal">{t('md.sessionToken')}</span>
                  <span className="text-muted-foreground truncate font-normal">{m.model}</span>
                </div>
                <div className="text-muted-foreground mt-0.5 truncate text-xs">
                  https://api-inference.modelscope.cn/v1{t('md.expoDefaultSuffix')}
                </div>
              </div>
            </div>
          ))}

        {draft && (
          <div className="border-border bg-card flex flex-col gap-4 rounded-xl border p-4">
            <div className="text-foreground text-sm font-medium">
              {draft.editing ? t('common.editing', { id: draft.id }) : t('md.add')}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label={t('common.name')}
                hint={t('md.nameHint')}
                value={draft.id}
                disabled={draft.editing}
                onChange={(v) => setDraft({ ...draft, id: v })}
              />
              <Field
                label={t('dp.servedName')}
                hint={t('md.modelHint')}
                value={draft.model}
                onChange={(v) => setDraft({ ...draft, model: v })}
              />
              <Field
                label="Base URL"
                hint={t('md.baseUrlHint')}
                value={draft.baseUrl}
                onChange={(v) => setDraft({ ...draft, baseUrl: v })}
              />
              <Field
                label="API Key"
                hint={t('md.keyHint')}
                value={draft.apiKey ?? ''}
                password
                onChange={(v) => setDraft({ ...draft, apiKey: v })}
              />
              <Field
                label={t('common.note')}
                hint={t('md.noteHint')}
                value={draft.note ?? ''}
                onChange={(v) => setDraft({ ...draft, note: v })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => void submit()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}

        {models.length === 0 && !draft && (
          <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t('md.empty')}
          </div>
        )}

        {models.map((m) => (
          <div
            key={m.id}
            className="border-border bg-card flex items-center gap-3 rounded-xl border p-4"
          >
            <span className="bg-primary/10 text-primary flex size-8 flex-none items-center justify-center rounded-lg">
              <Bot size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-foreground flex items-baseline gap-2 truncate text-sm font-medium">
                {m.id}
                {/*
                 * 只有本地部署类条目带探活结果（后端只在 note 为部署时探）；
                 * 远端 API 是用户自己保证的服务，不标状态免得被网络抖动误导。
                 */}
                {m.note === 'swift 部署' && (
                  <span
                    className={cn(
                      'flex-none text-[11px] font-normal',
                      m.alive ? 'text-state-done' : 'text-state-failed',
                    )}
                  >
                    {m.alive ? t('md.online') : t('md.stopped')}
                  </span>
                )}
                <span className="text-muted-foreground truncate font-normal">{m.model}</span>
              </div>
              <div className="text-muted-foreground mt-0.5 truncate text-xs">
                {m.baseUrl}
                {m.note ? ` · ${m.note}` : ''}
              </div>
            </div>
            {/* 展览模式机器配置只读：编辑/删除都不开放（服务端同样 403 双保险） */}
            {mode !== 'expo' && (
              <div className="flex flex-none gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => setDraft({ ...m, editing: true })}
                >
                  <Pencil size={14} />
                </Button>
                {/* window.confirm 在预览 iframe 里被沙箱禁掉（不弹窗恒 false），确认用 AlertDialog */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive size-8"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('md.delTitle', { id: m.id })}</AlertDialogTitle>
                      <AlertDialogDescription>{t('md.delDesc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          void deleteModel(m.id)
                            .then(refresh)
                            .then(() => toast.success(t('common.deleted', { name: m.id })))
                            .catch((e) => toast.error(String(e)));
                        }}
                      >
                        {t('common.delete')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        ))}
      </Column>
    </div>
  );
}

/** 表单里的一格：label + 说明 + 输入框，纵向紧凑排 */
function Field({
  label,
  hint,
  value,
  onChange,
  disabled,
  password,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  password?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-foreground text-[13px] font-medium">{label}</span>
      <Input
        value={value}
        disabled={disabled}
        type={password ? 'password' : 'text'}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        className="h-8 text-[13px]"
      />
      <span className="text-muted-foreground text-xs">{hint}</span>
    </label>
  );
}
