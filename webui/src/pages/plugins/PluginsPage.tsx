import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Column } from '@/components/Column';
import { TagInput } from '@/components/SearchSelect';
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
import { deletePlugin, listPlugins, savePlugin, type StoredPlugin } from '@/api/plugins';
import { useT } from '@/i18n';

/** 类型标签候选：swift 插件的常见 kind（自由输入不受限） */
const TAG_OPTIONS = [
  { value: 'model' },
  { value: 'dataset' },
  { value: 'template' },
  { value: 'reward' },
  { value: 'tool' },
  { value: 'sampler' },
  { value: 'loss' },
  { value: 'optimizer' },
];

/** 表单态：编辑时 id 只读（id 是主键，改名等于新增一份登记） */
interface Draft extends StoredPlugin {
  editing: boolean;
}

const EMPTY_DRAFT: Draft = { id: '', source: '', tags: [], editing: false };

/**
 * 插件管理。一条登记 = 一个 `--external_plugins` 来源（本地 .py / 本地
 * 文件夹 / hub id）：插件文件里的 @register 调用（自定义模型、模板、数据集、
 * 奖励、工具、采样器等所有类型）在任务启动前被加载生效。登记存
 * ~/.swift/plugins.json，训练等页面的插件选择下拉读这里。
 */
export function PluginsPage() {
  const { t } = useT();
  const [plugins, setPlugins] = useState<StoredPlugin[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await listPlugins());
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    if (!draft) return;
    if (!draft.source.trim()) {
      toast.error(t('pg.errSource'));
      return;
    }
    try {
      await savePlugin({
        ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
        source: draft.source.trim(),
        tags: draft.tags,
        note: draft.note,
      });
      toast.success(t('common.saved', { name: draft.id.trim() || draft.source.trim() }));
      setDraft(null);
      await refresh();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="pb-10">
      <PageHeader
        title={t('nav.plugins')}
        desc={t('nav.plugins.desc')}
        extra={
          <Button size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <Plus /> {t('pg.add')}
          </Button>
        }
      />

      <Column>
        {draft && (
          <div className="border-border bg-card flex flex-col gap-4 rounded-xl border p-4">
            <div className="text-foreground text-sm font-medium">
              {draft.editing ? t('common.editing', { id: draft.id }) : t('pg.add')}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-foreground text-[13px] font-medium">{t('common.name')}</span>
                <Input
                  value={draft.id}
                  disabled={draft.editing}
                  placeholder={t('pg.namePh')}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  className="h-8 text-[13px]"
                />
                <span className="text-muted-foreground text-xs">{t('pg.nameHint')}</span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-foreground text-[13px] font-medium">{t('common.source')}</span>
                <Input
                  value={draft.source}
                  placeholder={t('pg.sourcePh')}
                  onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                  className="h-8 text-[13px]"
                />
                <span className="text-muted-foreground text-xs">
                  本地 .py / 文件夹，或 ms:// / hf:// hub id；进命令行 --external_plugins
                </span>
              </label>
              <label className="flex flex-col gap-1.5 md:col-span-2">
                <span className="text-foreground text-[13px] font-medium">{t('pg.tagsLabel')}</span>
                <TagInput
                  values={draft.tags}
                  onChange={(tags) => setDraft({ ...draft, tags })}
                  options={TAG_OPTIONS}
                  placeholder={t('pg.tagsPh')}
                />
                <span className="text-muted-foreground text-xs">
                  {t('pg.tagsHint')}
                </span>
              </label>
              <label className="flex flex-col gap-1.5 md:col-span-2">
                <span className="text-foreground text-[13px] font-medium">{t('common.note')}</span>
                <Input
                  value={draft.note ?? ''}
                  placeholder={t('pg.notePh')}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  className="h-8 text-[13px]"
                />
              </label>
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

        {plugins.length === 0 && !draft && (
          <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t('pg.empty')}
          </div>
        )}

        {plugins.map((p) => {
          /* 工作空间扫描条目（agent 写进 workspace/plugins/ 的文件）：没有登记可删，
            删除=删文件，不在这个页面做——只展示与被选用 */
          const fromWorkspace = p.tags.includes('workspace');
          return (
          <div
            key={p.id}
            className="border-border bg-card flex items-center gap-3 rounded-xl border p-4"
          >
            <span className="bg-primary/10 text-primary flex size-8 flex-none items-center justify-center rounded-lg">
              <Plug size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-foreground flex flex-wrap items-baseline gap-2 truncate text-sm font-medium">
                {p.id}
                {p.tags.map((t) => (
                  <span key={t} className="bg-secondary text-foreground rounded px-1.5 py-0.5 text-[11px] font-normal">
                    {t}
                  </span>
                ))}
              </div>
              <div className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                {p.source}
                {p.note ? ` · ${p.note}` : ''}
              </div>
            </div>
            {!fromWorkspace && (
            <div className="flex flex-none gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setDraft({ ...p, editing: true })}
              >
                <Pencil size={14} />
              </Button>
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
                    <AlertDialogTitle>{t('pg.delTitle', { id: p.id })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('pg.delDesc')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        void deletePlugin(p.id)
                          .then(refresh)
                          .then(() => toast.success(t('common.deleted', { name: p.id })))
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
          );
        })}
      </Column>
    </div>
  );
}
