import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Package } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigFormShell } from '@/components/ConfigFormShell';
import { EMPTY_GPU_SELECTION, GpuPicker, type GpuSelection } from '@/components/GpuPicker';
import { SearchSelect, TagInput, type SearchOption } from '@/components/SearchSelect';
import type { ConfigField } from '@/components/PageAssistant';
import { Field, FieldStack, SelectInput } from '@/components/FormField';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { MODULES } from '@/theme/modules';
import { listCatalog, modelOption } from '@/api/catalog';
import { listPlugins } from '@/api/plugins';
import { listExports, startExport, type ExportTaskInfo } from '@/api/export';
import { pushRecent } from '@/store/recent';
import { prefillIntro, usePrefill } from '@/store/prefill';
import { useT } from '@/i18n';

type QuantMethod = 'none' | 'awq' | 'gptq' | 'bnb';

/** 位宽跟着方法走：awq / gptq 是 int4，bnb 是 int8——不单独给一个选项 */
function quantBits(method: Exclude<QuantMethod, 'none'>): number {
  return method === 'bnb' ? 8 : 4;
}

/**
 * 新建导出。表单直连 vite 任务执行器（POST /api/export）：一个任务 = 一次
 * `swift export` 子进程，LoRA 合并 / 量化 / 推送 Hub 可组合（CLI 支持链式：
 * 先合并再量化再推送）。产物固定落 ~/.swift/export/<任务 id>/output/。
 *
 * 源是两条路径：底座模型（--model）+ LoRA adapter（--adapters，训练产出
 * 的 checkpoint 目录）——webui 不枚举 checkpoint（训练目录不在管辖内），
 * 用户手填，与部署页的模型输入同风格。
 */
export function ExportNewPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefill = usePrefill('export');
  const [model, setModel] = useState('');
  const [adapters, setAdapters] = useState('');
  const [mergeLora, setMergeLora] = useState(true);
  const [quant, setQuant] = useState<QuantMethod>('none');
  const [calibDataset, setCalibDataset] = useState('');
  const [push, setPush] = useState(false);
  const [hubModelId, setHubModelId] = useState('');
  const [gpuSel, setGpuSel] = useState<GpuSelection>(EMPTY_GPU_SELECTION);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [extraArgs, setExtraArgs] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modelOptions, setModelOptions] = useState<SearchOption[]>([]);
  const [pluginOptions, setPluginOptions] = useState<SearchOption[]>([]);

  const quantOn = quant !== 'none';

  useEffect(() => {
    listCatalog()
      .then((c) => setModelOptions(c.models.map(modelOption)))
      .catch(() => {
        /* 清单不可达：SearchSelect 仍接受自由输入 */
      });
    listPlugins()
      .then((ps) => setPluginOptions(ps.map((p) => ({ value: p.source, label: p.id, hint: p.note }))))
      .catch(() => {
        /* 同上 */
      });
  }, []);

  /*
   * 「以此为模板新建」入口：?from=<任务 id> 预填该导出的源与操作组合。
   * 任务不存在（webui 重启后内存表清空）时静默退化为普通新建。
   */
  useEffect(() => {
    const from = searchParams.get('from');
    /* AI 预填与模板克隆是两个互斥入口：带了预填就不回填模板任务 */
    if (!from || prefill) return;
    listExports()
      .then((tasks) => {
        const src = tasks.find((x) => x.id === from);
        if (!src) return;
        setModel(src.model);
        setAdapters(src.adapters ?? '');
        setMergeLora(src.mergeLora);
        setQuant(src.quantMethod ?? 'none');
        setCalibDataset(src.calibDataset ?? '');
        setPush(src.pushToHub);
        setHubModelId(src.hubModelId ?? '');
        setPlugins(src.plugins ?? []);
        setExtraArgs(src.extraArgs ?? '');
        setGpuSel(src.gpus?.length ? { mode: 'local', cards: src.gpus, count: undefined } : EMPTY_GPU_SELECTION);
      })
      .catch(() => {
        /* 后端暂不可达：保持空表单 */
      });
  }, [searchParams]);

  /*
   * 首页 AI 创建工具带来的预填：mount 时读取（读取即清），字段缺失静默忽略。
   * 量化字段（quant）只收 none/awq/gptq/bnb 四值，其余丢弃交给页面默认。
   */
  useEffect(() => {
    if (!prefill) return;
    const f = prefill.fields;
    if (typeof f.model === 'string' && f.model.trim()) setModel(f.model.trim());
    if (typeof f.adapters === 'string') setAdapters(f.adapters.trim());
    if (typeof f.mergeLora === 'boolean') setMergeLora(f.mergeLora);
    if (f.quant === 'awq' || f.quant === 'gptq' || f.quant === 'bnb') setQuant(f.quant);
    if (typeof f.calibDataset === 'string' && f.calibDataset.trim()) setCalibDataset(f.calibDataset.trim());
    if (typeof f.push === 'boolean') setPush(f.push);
    if (typeof f.hubModelId === 'string' && f.hubModelId.trim()) setHubModelId(f.hubModelId.trim());
    if (Array.isArray(f.plugins)) setPlugins(f.plugins.map(String).filter(Boolean));
    if (Array.isArray(f.gpus) && f.gpus.length) {
      setGpuSel({
        mode: 'local',
        cards: f.gpus.map(Number).filter((n) => Number.isInteger(n) && n >= 0),
        count: undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = useMemo(() => {
    const lines = [
      t('tn.cmdComment'),
      ...(gpuSel.mode === 'local' && gpuSel.cards.length
        ? [`CUDA_VISIBLE_DEVICES=${gpuSel.cards.join(',')} \\`]
        : []),
      'USE_SWIFT_V5=1 swift export \\',
      `    --model ${model || t('exp.cmdModel')}`,
      ...(mergeLora ? [`    --adapters ${adapters || t('exp.cmdAdapters')} \\`, '    --merge_lora true \\'] : []),
      ...(quantOn
        ? [
            `    --quant_method ${quant} --quant_bits ${quantBits(quant)} \\`,
            ...(quant === 'awq' || quant === 'gptq'
              ? [`    --dataset ${calibDataset || t('exp.cmdCalib')} \\`]
              : []),
          ]
        : []),
      ...(push ? [`    --push_to_hub true --hub_model_id ${hubModelId || '<org/model>'} \\`] : []),
      ...(plugins.length ? [`    --external_plugins ${plugins.join(' ')} \\`] : []),
      ...(extraArgs.trim() ? [`    ${extraArgs.trim()} \\`] : []),
      t('exp.cmdOutput'),
    ];
    return lines.join('\n');
  }, [model, adapters, mergeLora, quant, calibDataset, push, hubModelId, quantOn, gpuSel, plugins, extraArgs, t]);

  const validate = (): string | null => {
    if (!model.trim()) return t('exp.errModel');
    if (!mergeLora && !quantOn && !push) return t('exp.errNoOp');
    if (mergeLora && !adapters.trim()) return t('exp.errAdapters');
    if ((quant === 'awq' || quant === 'gptq') && !calibDataset.trim()) return t('exp.errCalib', { quant });
    if (push && !hubModelId.trim()) return t('exp.errHub');
    return null;
  };

  const submit = async () => {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }
    setSubmitting(true);
    try {
      const id = await startExport({
        model: model.trim(),
        ...(mergeLora ? { adapters: adapters.trim() } : {}),
        mergeLora,
        ...(quantOn ? { quantMethod: quant } : {}),
        ...((quant === 'awq' || quant === 'gptq') && calibDataset.trim()
          ? { calibDataset: calibDataset.trim() }
          : {}),
        pushToHub: push,
        ...(push ? { hubModelId: hubModelId.trim() } : {}),
        ...(plugins.length ? { plugins } : {}),
        ...(extraArgs.trim() ? { extraArgs: extraArgs.trim() } : {}),
        ...(gpuSel.mode === 'local' && gpuSel.cards.length ? { gpus: gpuSel.cards } : {}),
      });
      pushRecent({
        id: `export:${id}`,
        label: t('exp.taskLabel', { name: adapters.trim() || model.trim().split('/').pop() || model.trim() }),
        path: `/export/${id}/artifact`,
      });
      toast.success(t('exp.started'));
      navigate('/export');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  /* 交给 AI 助手的字段 */
  const fields: ConfigField[] = [
    { key: 'model', label: t('exp.baseModel'), value: model, apply: setModel },
    { key: 'adapters', label: 'LoRA adapter', value: adapters, apply: setAdapters },
    { key: 'merge_lora', label: t('exp.mergeLora'), value: mergeLora ? 'on' : 'off', apply: (v) => setMergeLora(v === 'on') },
    { key: 'quant_method', label: t('exp.quantMethod'), value: quant, apply: (v) => setQuant(v as QuantMethod) },
    {
      key: 'push_to_hub',
      label: t('exp.pushHub'),
      value: push ? 'on' : 'off',
      apply: (v) => setPush(v === 'on'),
    },
    {
      key: 'gpu',
      label: 'GPU',
      value: gpuSel.mode === 'local' ? gpuSel.cards.join(',') : '',
      apply: () => {},
    },
  ];

  return (
    <ConfigFormShell
      module={MODULES.export}
      title={t('exp.newExport')}
      desc={t('exp.desc')}
      preview={preview}
      fields={fields}
      onSubmit={() => void submit()}
      extraArgs={extraArgs}
      onExtraArgsChange={setExtraArgs}
      warning={t('exp.warn')}
      actions={
        <Button onClick={() => void submit()} disabled={submitting}>
          <Package /> {submitting ? t('tn.launching') : t('exp.launchBtn')}
        </Button>
      }
      sections={[
        {
          title: t('exp.secSource'),
          content: (
            <FieldStack>
              <Field label={t('exp.baseModel')} hint={t('tn.modelHint')}>
                <SearchSelect
                  value={model}
                  onChange={setModel}
                  options={modelOptions}
                  placeholder="Qwen/Qwen2.5-0.5B-Instruct"
                />
              </Field>
              <Field label="LoRA adapter" hint={t('exp.adapterHint')}>
                <Input
                  value={adapters}
                  onChange={(e) => setAdapters(e.target.value)}
                  placeholder="/path/to/output/vx-xxx/checkpoint-xxx"
                  className="h-8 text-[13px]"
                />
              </Field>
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
          title: t('exp.secOps'),
          content: (
            <FieldStack>
              <Field label={t('exp.mergeLabel')} hint={t('exp.mergeHint')}>
                <Switch checked={mergeLora} onCheckedChange={setMergeLora} />
              </Field>
              <Field label={t('exp.quantMethod')} hint={t('exp.quantHint')}>
                <SelectInput
                  value={quant}
                  onChange={(v) => setQuant(v as QuantMethod)}
                  options={[
                    { value: 'none', label: t('exp.optNone') },
                    { value: 'awq', label: 'AWQ (int4)' },
                    { value: 'gptq', label: 'GPTQ (int4)' },
                    { value: 'bnb', label: 'BitsAndBytes (int8)' },
                  ]}
                />
              </Field>
              {quantOn && (quant === 'awq' || quant === 'gptq') && (
                <Field label={t('exp.calibLabel')} hint={t('exp.calibHint', { quant })}>
                  <Input
                    value={calibDataset}
                    onChange={(e) => setCalibDataset(e.target.value)}
                    placeholder="AI-ModelScope/alpaca-gpt4-data-zh"
                    className="h-8 text-[13px]"
                  />
                </Field>
              )}
            </FieldStack>
          ),
        },
        {
          title: t('tn.secGpu'),
          content: (
            <FieldStack>
              <Field
                label={t('tn.gpuLabel')}
                hint={t('exp.gpuHint')}
              >
                <GpuPicker value={gpuSel} onChange={setGpuSel} />
              </Field>
            </FieldStack>
          ),
        },
        {
          title: t('exp.secHub'),
          content: (
            <FieldStack>
              <Field label={t('exp.pushLabel')}>
                <Switch checked={push} onCheckedChange={setPush} />
              </Field>
              {push && (
                <Field label="hub_model_id" hint={t('exp.hubIdHint')}>
                  <Input
                    value={hubModelId}
                    onChange={(e) => setHubModelId(e.target.value)}
                    placeholder="my-org/my-model"
                    className="h-8 text-[13px]"
                  />
                </Field>
              )}
            </FieldStack>
          ),
        },
      ]}
      assistantAutoOpen={Boolean(prefill?.context)}
      assistantIntro={prefill?.context ? prefillIntro('导出', prefill) : undefined}
      assistantConv={prefill?.context?.conv}
      assistantModel={prefill?.context?.model}
    />
  );
}
