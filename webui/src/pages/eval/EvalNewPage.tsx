import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigFormShell } from '@/components/ConfigFormShell';
import type { ConfigField } from '@/components/PageAssistant';
import { Field, FieldStack, NumberInput, SegmentedControl, SelectInput } from '@/components/FormField';
import { TagInput, type SearchOption } from '@/components/SearchSelect';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MODULES } from '@/theme/modules';
import { listModels, type ModelConfig } from '@/api/models';
import { listPlugins } from '@/api/plugins';
import {
  listEvalDatasets,
  listEvals,
  startEval,
  type EvalDatasetInfo,
  type EvalItem,
  type EvalLocalTarget,
} from '@/api/eval';
import { pushRecent } from '@/store/recent';
import { prefillIntro, usePrefill } from '@/store/prefill';
import { useT } from '@/i18n';

/** 已选评测集在侧栏的摘要：带 limit 的标条数，否则标全量 */
function itemSummary(items: EvalItem[]): string {
  return items
    .map((it) => (it.limit ? `${it.dataset}(${it.limit})` : it.dataset))
    .join(' ');
}

/**
 * 新建评测。被测模型只能选模型配置（models.json）里的条目——评测走 swift eval
 * 的 api 模式（--eval_url 指向该条目的端点），本地不加载任何模型。评测集来自
 * EvalScope 的数据集注册表（可搜索），每个集可独立设「只评前 N 条」。
 */
export function EvalNewPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefill = usePrefill('eval');
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [datasets, setDatasets] = useState<EvalDatasetInfo[]>([]);
  const [modelId, setModelId] = useState('');
  /** 搜索关键词过滤 207 个基准 */
  const [query, setQuery] = useState('');
  /** 选中项的 limit（key = dataset name；undefined = 全量） */
  const [items, setItems] = useState<EvalItem[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [extraArgs, setExtraArgs] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pluginOptions, setPluginOptions] = useState<SearchOption[]>([]);
  /*
   * 本地直评（autoresearch 的训后 checkpoint 评测主用；这里是最小手填入口）：
   * 底座 + adapters 直接评，不连端点。与 api 模式互斥，评测集选择共用。
   */
  const [localMode, setLocalMode] = useState(false);
  const [baseModel, setBaseModel] = useState('');
  const [adapters, setAdapters] = useState('');
  const [gpus, setGpus] = useState('');

  useEffect(() => {
    listModels()
      .then((configs) => {
        setModels(configs);
        setModelId((prev) => prev || configs[0]?.id || '');
      })
      .catch((e) => toast.error(String(e)));
    listEvalDatasets()
      .then(setDatasets)
      .catch((e) => toast.error(String(e)));
    listPlugins()
      .then((ps) => setPluginOptions(ps.map((p) => ({ value: p.source, label: p.id, hint: p.note }))))
      .catch(() => {
        /* 清单不可达：TagInput 仍接受自由输入 */
      });
  }, []);

  /*
   * 「以此为模板新建」入口：?from=<任务 id> 预填被测模型与评测集（含每集的
   * limit）。任务不存在（webui 重启后内存表清空）时静默退化为普通新建；
   * listModels 的默认选中不会覆盖这里设的 modelId（它的 setModelId 只在
   * prev 为空时生效）。
   */
  useEffect(() => {
    const from = searchParams.get('from');
    /* AI 预填与模板克隆是两个互斥入口：带了预填就不回填模板任务 */
    if (!from || prefill) return;
    listEvals()
      .then((tasks) => {
        const src = tasks.find((x) => x.id === from);
        if (!src) return;
        setModelId(src.modelId);
        setItems(src.items.map((it) => ({ ...it })));
        setPlugins(src.plugins ?? []);
        setExtraArgs(src.extraArgs ?? '');
      })
      .catch(() => {
        /* 后端暂不可达：保持空表单 */
      });
  }, [searchParams]);

  /*
   * 首页 AI 创建工具带来的预填：mount 时读取（读取即清），字段缺失静默忽略。
   * 评测集项带可选 limit；数据集名不在注册表里的照收——页面提交前自会校验。
   */
  useEffect(() => {
    if (!prefill) return;
    const f = prefill.fields;
    if (typeof f.modelId === 'string' && f.modelId.trim()) setModelId(f.modelId.trim());
    if (Array.isArray(f.items)) {
      setItems(
        f.items
          .map((it) => {
            const d = String((it as Record<string, unknown>).dataset ?? '').trim();
            const limit = Number((it as Record<string, unknown>).limit);
            return d ? { dataset: d, ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}) } : null;
          })
          .filter((it): it is EvalItem => !!it),
      );
    }
    if (Array.isArray(f.plugins)) setPlugins(f.plugins.map(String).filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return datasets;
    return datasets.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.prettyName.toLowerCase().includes(q) ||
        d.tags.some((x) => x.toLowerCase().includes(q)),
    );
  }, [datasets, query]);

  const toggle = (name: string) =>
    setItems((prev) =>
      prev.some((it) => it.dataset === name)
        ? prev.filter((it) => it.dataset !== name)
        : [...prev, { dataset: name }],
    );

  const setLimit = (name: string, limit: number | undefined) =>
    setItems((prev) =>
      prev.map((it) => (it.dataset === name ? { ...it, limit: limit && limit > 0 ? limit : undefined } : it)),
    );

  const model = models.find((m) => m.id === modelId);

  /* 本地直评目标：adapters/gpus 都是空白或逗号分隔的多值 */
  const localTarget: EvalLocalTarget | undefined = localMode
    ? {
        model: baseModel.trim(),
        ...(adapters.trim()
          ? { adapters: adapters.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean) }
          : {}),
        ...(gpus.trim()
          ? {
              gpus: gpus
                .split(/[\s,]+/)
                .map(Number)
                .filter((n) => Number.isInteger(n) && n >= 0),
            }
          : {}),
      }
    : undefined;

  const preview = useMemo(() => {
    /* 本地直评：--model 底座 + --adapters checkpoint，无 eval_url */
    if (localMode) {
      if (!baseModel.trim() || !items.length) {
        return t('ev.cmdHintLocal');
      }
      const tail =
        (adapters.trim() ? ` \\\n    --adapters ${adapters.split(/[\s,]+/).filter(Boolean).join(' ')}` : '') +
        (gpus.trim() ? `  # CUDA_VISIBLE_DEVICES=${gpus}` : '');
      return [
        t('ev.cmdLocalNote'),
        ...items.map(
          (it) =>
            `swift eval \\\n    --model ${baseModel.trim()}${tail} \\\n    --eval_dataset ${it.dataset}` +
            (it.limit ? ` \\\n    --eval_limit ${it.limit}` : ''),
        ),
      ].join('\n\n');
    }
    if (!model || !items.length) {
      return t('ev.cmdHintApi');
    }
    /* 插件与附加参数对每个评测集都生效 */
    const tail =
      (plugins.length ? ` \\\n    --external_plugins ${plugins.join(' ')}` : '') +
      (extraArgs.trim() ? ` \\\n    ${extraArgs.trim()}` : '');
    return [
      t('ev.cmdApiNote'),
      ...items.map(
        (it) =>
          `swift eval \\` +
          `\n    --model ${model.model} \\` +
          `\n    --eval_url ${model.baseUrl} \\` +
          `\n    --eval_dataset ${it.dataset}` +
          (it.limit ? ` \\\n    --eval_limit ${it.limit}` : '') +
          tail,
      ),
    ].join('\n\n');
  }, [localMode, baseModel, adapters, gpus, model, items, plugins, extraArgs, t]);

  const submit = async () => {
    if (localMode && !baseModel.trim()) {
      toast.error(t('ev.errBase'));
      return;
    }
    if (!localMode && (!modelId || !model)) {
      toast.error(t('ev.errModel'));
      return;
    }
    if (!items.length) {
      toast.error(t('ev.errDatasets'));
      return;
    }
    setSubmitting(true);
    try {
      const id = await startEval({
        ...(localMode ? { local: localTarget } : { modelId }),
        items,
        ...(plugins.length ? { plugins } : {}),
        ...(extraArgs.trim() ? { extraArgs: extraArgs.trim() } : {}),
      });
      pushRecent({
        id: `eval:${id}`,
        label: t('ev.taskLabel', { name: localMode ? baseModel.trim() : modelId }),
        path: `/eval/${id}/overview`,
      });
      toast.success(t('ev.started'));
      navigate('/eval');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  /* 交给 AI 助手的字段 */
  const fields: ConfigField[] = [
    {
      key: 'model',
      label: t('ev.modelUnderTest'),
      value: localMode ? baseModel : modelId,
      apply: localMode ? setBaseModel : setModelId,
    },
    {
      key: 'eval_dataset',
      label: t('ev.datasets'),
      value: itemSummary(items),
      /* AI 能引用所选集，但增删以用户在列表里的勾选为准 */
      apply: (v) =>
        setItems(
          v
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((token) => {
              const m = token.match(/^(.+)\((\d+)\)$/);
              return m
                ? { dataset: m[1], limit: Number(m[2]) }
                : { dataset: token };
            })
            .filter((it) => datasets.some((d) => d.name === it.dataset)),
        ),
    },
  ];

  return (
    <ConfigFormShell
      module={MODULES.eval}
      title={t('ev.newEval')}
      desc={t('ev.desc')}
      preview={preview}
      fields={fields}
      extraArgs={extraArgs}
      onExtraArgsChange={setExtraArgs}
      warning={t('ev.warn')}
      actions={
        <Button onClick={() => void submit()} disabled={submitting}>
          <FlaskConical /> {submitting ? t('tn.launching') : t('ev.launchBtn')}
        </Button>
      }
      sections={[
        {
          title: t('ev.modelUnderTest'),
          content: (
            <FieldStack>
              <Field
                label={t('ev.method')}
                hint={t('ev.methodHint')}
              >
                <SegmentedControl
                  value={localMode ? 'local' : 'api'}
                  onChange={(v) => setLocalMode(v === 'local')}
                  options={[
                    { value: 'api', label: t('ev.optApi') },
                    { value: 'local', label: t('ev.optLocal') },
                  ]}
                />
              </Field>
              {localMode ? (
                <>
                  <Field label={t('exp.baseModel')} hint={t('ev.baseHint')}>
                    <Input
                      value={baseModel}
                      onChange={(e) => setBaseModel(e.target.value)}
                      placeholder="Qwen/Qwen2.5-0.5B-Instruct"
                      className="h-8 text-[13px]"
                    />
                  </Field>
                  <Field label={t('ev.adaptersLabel')} hint={t('ev.adaptersHint')}>
                    <Input
                      value={adapters}
                      onChange={(e) => setAdapters(e.target.value)}
                      placeholder="/root/.../output/v1-20250101-120000"
                      className="h-8 font-mono text-[13px]"
                    />
                  </Field>
                  <Field label={t('ev.gpusLabel')} hint={t('ev.gpusHint')}>
                    <Input
                      value={gpus}
                      onChange={(e) => setGpus(e.target.value)}
                      placeholder="0,1"
                      className="h-8 font-mono text-[13px]"
                    />
                  </Field>
                </>
              ) : (
                <Field label={t('tn.modelLabel')} hint={t('ev.modelHint')}>
                  {models.length ? (
                    <SelectInput
                      value={modelId}
                      onChange={setModelId}
                      options={models.map((m) => ({
                        value: m.id,
                        label: m.note === 'swift 部署' ? `${m.id}${t('ev.deployedSuffix')}` : m.id,
                      }))}
                    />
                  ) : (
                    <div className="text-muted-foreground text-[13px]">
                      {t('ev.noModels')}
                    </div>
                  )}
                </Field>
              )}
              <Field
                label={t('tn.pluginsLabel')}
                hint={t('tn.pluginsHint')}
              >
                <TagInput
                  values={plugins}
                  onChange={setPlugins}
                  options={pluginOptions}
                  placeholder="/path/to/plugin.py"
                />
              </Field>
            </FieldStack>
          ),
        },
        {
          title: t('ev.datasets'),
          content: (
            <FieldStack>
              <Field
                label={t('ev.pickLabel', { n: items.length })}
                hint={t('ev.pickHint')}
              >
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('ev.searchPh')}
                  className="h-8 text-[13px]"
                />
              </Field>
              <div className="border-border/60 max-h-80 overflow-auto rounded-lg border">
                {filtered.map((d) => {
                  const picked = items.find((it) => it.dataset === d.name);
                  return (
                    <div
                      key={d.name}
                      className="border-border/60 hover:bg-muted/50 flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                    >
                      <button
                        type="button"
                        onClick={() => toggle(d.name)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <span
                          className={
                            picked
                              ? 'bg-primary text-primary-foreground flex size-4 flex-none items-center justify-center rounded text-[10px]'
                              : 'border-border size-4 flex-none rounded border'
                          }
                        >
                          {picked ? '✓' : ''}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground block truncate text-[13px]">
                            {d.name}
                            {d.prettyName !== d.name && (
                              <span className="text-muted-foreground"> · {d.prettyName}</span>
                            )}
                          </span>
                          {(d.tags.length > 0 || d.metrics.length > 0) && (
                            <span className="text-muted-foreground/70 block truncate text-[11px]">
                              {[...d.tags, ...d.metrics].slice(0, 6).join(' / ')}
                            </span>
                          )}
                        </span>
                      </button>
                      {picked && (
                        /* 每集独立采样：limit 留空 = 全量评测 */
                        <div className="flex flex-none items-center gap-1.5">
                          <span className="text-muted-foreground text-[11px]">{t('ev.limitBefore')}</span>
                          <NumberInput
                            className="h-7 w-20 text-[13px]"
                            value={picked.limit}
                            onChange={(n) => setLimit(d.name, n)}
                            min={1}
                          />
                          <span className="text-muted-foreground text-[11px]">{t('ev.limitAfter')}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {filtered.length === 0 && (
                  <div className="text-muted-foreground px-3 py-4 text-[13px]">{t('ev.noMatch')}</div>
                )}
              </div>
            </FieldStack>
          ),
        },
      ]}
      assistantAutoOpen={Boolean(prefill?.context)}
      assistantIntro={prefill?.context ? prefillIntro('评测', prefill) : undefined}
      assistantConv={prefill?.context?.conv}
      assistantModel={prefill?.context?.model}
    />
  );
}
