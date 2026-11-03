import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Lightbulb, Bot, Globe, KeyRound, Palette, Undo2, Plus, Trash2, Terminal, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Column } from '@/components/Column';
import { NumberInput, SegmentedControl, SelectInput } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { TIPS, visibleTips } from '@/config/tips';
import { useSettings, type ChatDefaults } from '@/settings/SettingsContext';
import { LOCALES, useT } from '@/i18n';
import { clearSearchKey, getSearchConfig, saveSearchKey } from '@/api/search';
import { addDataRoot, listDataRoots, removeDataRoot } from '@/api/dataRoots';
import { newPromptId, PRESET_SYSTEM_PROMPTS, type SystemPromptsState } from '@/store/systemPrompts';

/**
 * 偏好设置。
 *
 * 走的是「一行一件事」的排法，不套表单——这些开关彼此独立，
 * 套一层表单只会多出提交按钮和校验状态两样不需要的东西。改完即生效。
 */
export function SettingsPage() {
  const { settings, update, reset, tipsDismissed, mode } = useSettings();
  const { t, locale, setLocale } = useT();
  const poolSize = visibleTips(settings.tipsBeginnerOnly).length;

  /*
   * 联网搜索的 key 不走 SettingsContext（localStorage）：key 只能存运行机器
   * （~/.swift/search.json，模型配置同款铁律），这里只是它的管理界面。
   * hasKey 只表达「配没配」，明文永远不出服务端。
   */
  const [hasKey, setHasKey] = useState(false);
  const [tavilyKey, setTavilyKey] = useState('');

  /*
   * 外部数据目录（机器侧 ~/.swift/data-roots.json，与搜索 key 同一铁律）：
   * 登记给 agent 文件工具只读探查原始数据用的本机目录。这里只是它的管理界面。
   */
  const [dataRoots, setDataRoots] = useState<string[]>([]);
  const [rootInput, setRootInput] = useState('');

  /*
   * System 提示词库活在全局设置里（机器侧持久）；改完即存（防抖 POST）即生效
   * ——对话页每次发送现读。
   */
  const sysPrompts = settings.systemPrompts;
  const persistPrompts = (next: SystemPromptsState) => update('systemPrompts', next);
  const updatePrompt = (id: string, patch: Partial<{ name: string; text: string }>) =>
    persistPrompts({
      ...sysPrompts,
      prompts: sysPrompts.prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  const removePrompt = (id: string) => {
    if (sysPrompts.prompts.length <= 1) {
      toast.warning(t('settings.keepOnePrompt'));
      return;
    }
    const prompts = sysPrompts.prompts.filter((p) => p.id !== id);
    const fallback = prompts[0].id;
    persistPrompts({
      ...sysPrompts,
      prompts,
      baseId: sysPrompts.baseId === id ? fallback : sysPrompts.baseId,
      researchId: sysPrompts.researchId === id ? fallback : sysPrompts.researchId,
    });
  };
  const addPrompt = () =>
    persistPrompts({
      ...sysPrompts,
      prompts: [
        ...sysPrompts.prompts,
        { id: newPromptId(sysPrompts.prompts), name: t('settings.customPromptName', { n: sysPrompts.prompts.length - 1 }), text: '' },
      ],
    });

  useEffect(() => {
    getSearchConfig()
      .then((c) => setHasKey(Boolean(c.tavilyKey)))
      .catch((e) => toast.error(String(e)));
    if (mode !== 'expo') {
      listDataRoots()
        .then(setDataRoots)
        .catch((e) => toast.error(String(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = async () => {
    if (!tavilyKey.trim()) return;
    try {
      await saveSearchKey(tavilyKey.trim());
      setHasKey(true);
      setTavilyKey('');
      toast.success(t('settings.keySaved'));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const removeKey = async () => {
    try {
      await clearSearchKey();
      setHasKey(false);
      setTavilyKey('');
      toast.success(t('settings.keyCleared'));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const addRoot = async () => {
    if (!rootInput.trim()) return;
    try {
      setDataRoots(await addDataRoot(rootInput.trim()));
      setRootInput('');
      toast.success(t('settings.rootAdded'));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const removeRoot = async (p: string) => {
    try {
      await removeDataRoot(p);
      setDataRoots((rs) => rs.filter((r) => r !== p));
    } catch (e) {
      toast.error(String(e));
    }
  };

  /*
   * 展览模式的登录门：设置页承载的是本会话的偏好（内存态），须先登录才开放。
   * 正常模式无门——单用户自用，机器侧文件就是自己的。
   */
  return (
    <div className="pb-10">
      <PageHeader
        title={t('settings.title')}
        desc={
          mode === 'expo'
            ? t('settings.descExpo')
            : t('settings.descNormal')
        }
        extra={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              toast.success(t('settings.resetDone'));
            }}
          >
            <Undo2 /> {t('settings.resetDefaults')}
          </Button>
        }
      />

      <Column>
        {/* 外观：语言与主题（与侧栏/标题栏的切换器同源） */}
        <Group icon={<Palette size={13} />} title={t('settings.appearance')} desc={t('settings.appearanceDesc')}>
          <Row label={t('settings.language')} hint={t('settings.languageHint')}>
            <SelectInput
              className="w-44"
              value={locale}
              onChange={(v) => setLocale(v as typeof locale)}
              options={LOCALES.map((l) => ({ value: l.value, label: l.label }))}
            />
          </Row>
          <Row label={t('settings.theme')}>
            <SegmentedControl
              value={settings.theme}
              onChange={(v) => update('theme', v as typeof settings.theme)}
              options={[
                { value: 'light', label: t('theme.light') },
                { value: 'dark', label: t('theme.dark') },
                { value: 'system', label: t('theme.system') },
              ]}
            />
          </Row>
        </Group>
      
        <Group icon={<Lightbulb size={13} />} title={t('settings.tips')} desc={t('settings.tipsDesc')}>
          <Row
            label={t('settings.tipsBar')}
            hint={
              tipsDismissed && settings.tipsEnabled
                ? t('settings.tipsDismissed')
                : t('settings.tipsPool', { visible: poolSize, total: TIPS.length })
            }
          >
            <Switch
              checked={settings.tipsEnabled}
              onCheckedChange={(v) => update('tipsEnabled', v)}
            />
          </Row>
      
          <Row label={t('settings.tipsBeginnerOnly')} hint={t('settings.tipsBeginnerOnlyHint')}>
            <Switch
              checked={settings.tipsBeginnerOnly}
              disabled={!settings.tipsEnabled}
              onCheckedChange={(v) => update('tipsBeginnerOnly', v)}
            />
          </Row>
      
          <Row label={t('settings.tipsInterval')} hint={t('settings.tipsIntervalHint', { sec: settings.tipsInterval })}>
            {/*
              Radix 的 Slider 是多游标模型，value 永远是数组，所以这里进出都要拆装一次。
              当前值不显示在游标上而是写进上面那句 hint：拖动时提示气泡会挡住相邻的行，
              而这一页的说明文字本来就在左边，读起来是连贯的。
            */}
            <Slider
              className="w-50"
              min={5}
              max={40}
              step={1}
              disabled={!settings.tipsEnabled}
              value={[settings.tipsInterval]}
              onValueChange={([v]) => update('tipsInterval', v)}
            />
          </Row>
        </Group>

        <Group icon={<Bot size={13} />} title={t('settings.ai')} desc={t('settings.aiDesc')}>
          <Row label={t('settings.aiEnabled')} hint={t('settings.aiEnabledHint')}>
            <Switch checked={settings.aiEnabled} onCheckedChange={(v) => update('aiEnabled', v)} />
          </Row>
        
          <Row
            label={t('settings.aiConfirm')}
            hint={t('settings.aiConfirmHint')}
          >
            <Switch
              checked={settings.aiConfirmBeforeApply}
              disabled={!settings.aiEnabled}
              onCheckedChange={(v) => {
                update('aiConfirmBeforeApply', v);
                if (!v) toast.warning(t('settings.aiConfirmOffToast'));
              }}
            />
          </Row>
        </Group>

        {/*
         * System 提示词库。对话页两个形态各绑一条：普通对话（测训练效果）与
         * 「研究」胶囊（auto-research 协助）。预设两条，可编辑可新增。
         */}
        <Group
          icon={<Bot size={13} />}
          title={t('settings.prompts')}
          desc={t('settings.promptsDesc')}
        >
          <Row
            label={t('settings.basePrompt')}
            hint={t('settings.basePromptHint')}
          >
            <SelectInput
              className="w-44"
              value={sysPrompts.baseId}
              onChange={(v) => persistPrompts({ ...sysPrompts, baseId: v })}
              options={sysPrompts.prompts.map((p) => ({ value: p.id, label: p.nameKey ? t(p.nameKey) : p.name }))}
            />
          </Row>
          <Row
            label={t('settings.researchPrompt')}
            hint={t('settings.researchPromptHint')}
          >
            <SelectInput
              className="w-44"
              value={sysPrompts.researchId}
              onChange={(v) => persistPrompts({ ...sysPrompts, researchId: v })}
              options={sysPrompts.prompts.map((p) => ({ value: p.id, label: p.nameKey ? t(p.nameKey) : p.name }))}
            />
          </Row>
          {sysPrompts.prompts.map((p) => (
            <div key={p.id} className="border-border/60 border-b px-0.5 py-3.5">
              <div className="flex items-center gap-2">
                <Input
                  value={p.name}
                  onChange={(e) => updatePrompt(p.id, { name: e.target.value })}
                  placeholder={t('settings.promptNamePlaceholder')}
                  className="h-8 w-44 text-[13px]"
                />
                <span className="text-muted-foreground text-[11px]">
                  {p.id === sysPrompts.baseId && t('settings.promptBaseTag')}
                  {p.id === sysPrompts.baseId && p.id === sysPrompts.researchId && ' · '}
                  {p.id === sysPrompts.researchId && t('settings.promptResearchTag')}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto"
                  onClick={() => removePrompt(p.id)}
                >
                  <Trash2 /> {t('common.delete')}
                </Button>
              </div>
              <Textarea
                value={p.text}
                onChange={(e) => updatePrompt(p.id, { text: e.target.value })}
                placeholder={t('settings.promptTextPlaceholder')}
                spellCheck={false}
                className="mt-2 font-mono text-xs leading-5"
                rows={p.text.length > 400 ? 8 : 3}
              />
            </div>
          ))}
          <div className="border-border/60 flex items-center gap-2 border-b px-0.5 py-3.5">
            <Button size="sm" variant="outline" onClick={addPrompt}>
              <Plus /> {t('settings.addPrompt')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                persistPrompts(PRESET_SYSTEM_PROMPTS);
                toast.success(t('settings.promptsRestored'));
              }}
            >
              <Undo2 /> {t('settings.restorePrompts')}
            </Button>
          </div>
        </Group>

        {/*
         * 联网搜索组。key 存在运行机器（与模型配置同一铁律，见上面 state 注释），
         * 所以这一组不进 SettingsContext 的 localStorage——「恢复默认」也不会动它。
         * 展览模式整组隐藏：机器侧 key 是共享面且写入已被服务端 403。
         */}
        {mode !== 'expo' && (
          <Group icon={<Globe size={13} />} title={t('settings.search')} desc={t('settings.searchDesc')}>
          <Row
            label={t('settings.tavilyKey')}
            hint={
              hasKey
                ? t('settings.tavilyKeyHintOn')
                : t('settings.tavilyKeyHintOff')
            }
          >
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={tavilyKey}
                onChange={(e) => setTavilyKey(e.target.value)}
                placeholder={hasKey ? t('settings.tavilyPlaceholderOn') : t('settings.tavilyPlaceholderOff')}
                className="w-52"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void saveKey();
                  }
                }}
              />
              <Button size="sm" disabled={!tavilyKey.trim()} onClick={() => void saveKey()}>
                {t('common.save')}
              </Button>
              {hasKey && (
                <Button size="sm" variant="ghost" onClick={() => void removeKey()}>
                  {t('common.clear')}
                </Button>
              )}
            </div>
          </Row>
          </Group>
        )}

        {mode !== 'expo' && (
          <Group
            icon={<FolderInput size={13} />}
            title={t('settings.dataRoots')}
            desc={t('settings.dataRootsDesc')}
          >
            {dataRoots.map((p) => (
              <Row key={p} label={p} hint={t('settings.dataRootHint')}>
                <Button size="sm" variant="ghost" onClick={() => void removeRoot(p)}>
                  <Trash2 /> {t('settings.remove')}
                </Button>
              </Row>
            ))}
            <Row
              label={t('settings.addDataRoot')}
              hint={
                dataRoots.length
                  ? t('settings.dataRootHintHas')
                  : t('settings.dataRootHintEmpty')
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  value={rootInput}
                  onChange={(e) => setRootInput(e.target.value)}
                  placeholder="/data/my-business"
                  spellCheck={false}
                  className="w-64"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void addRoot();
                    }
                  }}
                />
                <Button size="sm" disabled={!rootInput.trim()} onClick={() => void addRoot()}>
                  {t('settings.register')}
                </Button>
              </div>
            </Row>
          </Group>
        )}

        <Group title={t('settings.canvas')} desc={t('settings.canvasDesc')}>
          <Row label={t('settings.autoOpenOutput')} hint={t('settings.autoOpenOutputHint')}>
            <Switch
              checked={settings.autoOpenOutput}
              onCheckedChange={(v) => update('autoOpenOutput', v)}
            />
          </Row>
        </Group>

        {/*
         * 运行环境：任务执行器 spawn 的 python。改成设置项的原因：容器里 PATH
         * 前排的解释器未必装了 ray/vllm/twinkle，换环境不该改代码。优先级
         * SWIFT_PYTHON 环境变量 > 这里的值 > 服务端内置默认；每次 spawn 现读。
         */}
        <Group icon={<Terminal size={13} />} title={t('settings.runtime')} desc={t('settings.runtimeDesc')}>
          <Row
            label={t('settings.python')}
            hint={
              settings.pythonPath
                ? t('settings.pythonHintSet')
                : t('settings.pythonHintEmpty')
            }
          >
            <Input
              value={settings.pythonPath ?? ''}
              onChange={(e) => update('pythonPath', e.target.value.trim() || null)}
              placeholder="/usr/local/bin/python"
              spellCheck={false}
              className="w-64"
            />
          </Row>
        </Group>

        {/*
         * ModelScope 访问令牌（PAT）：research 对话的默认模型与 tinker 服务的
         * 鉴权凭据。展览模式只留本浏览器会话内存（关页即失）；本地模式存本机
         * 设置文件。不填不影响其他能力——本地部署、自配 key 的模型照常可用。
         */}
        <Group icon={<KeyRound size={13} />} title={t('settings.msToken')} desc={t('settings.msTokenHint')}>
          <Row label={t('settings.msToken')} hint={t('settings.msTokenHint')}>
            <Input
              value={settings.msToken}
              onChange={(e) => update('msToken', e.target.value.trim())}
              placeholder="ms-…"
              spellCheck={false}
              type="password"
              className="w-64"
            />
          </Row>
        </Group>

        {/*
         * 对话默认参数：新建会话的滑杆初始值。会话内手调不受影响，只影响
         * 下一次打开对话页时的起点。
         */}
        <Group title={t('settings.chatDefaults')} desc={t('settings.chatDefaultsDesc')}>
          <Row label={t('settings.temperature')} hint={t('settings.temperatureHint')}>
            <NumberInput
              value={settings.chatDefaults.temperature}
              onChange={(n) => update('chatDefaults', { ...settings.chatDefaults, temperature: n ?? 0.7 })}
            />
          </Row>
          <Row label={t('settings.topP')} hint={t('settings.topPHint')}>
            <NumberInput
              value={settings.chatDefaults.topP}
              onChange={(n) => update('chatDefaults', { ...settings.chatDefaults, topP: n ?? 0.8 })}
            />
          </Row>
          <Row label={t('settings.maxTokens')} hint={t('settings.maxTokensHint')}>
            <NumberInput
              value={settings.chatDefaults.maxTokens}
              onChange={(n) => update('chatDefaults', { ...settings.chatDefaults, maxTokens: n ?? 8192 })}
            />
          </Row>
          <Row label={t('settings.thinking')} hint={t('settings.thinkingHint')}>
            <SegmentedControl
              value={settings.chatDefaults.thinking}
              onChange={(v) =>
                update('chatDefaults', { ...settings.chatDefaults, thinking: v as ChatDefaults['thinking'] })
              }
              options={[
                { value: 'off', label: t('settings.thinkingOff') },
                { value: 'mid', label: t('settings.thinkingMid') },
                { value: 'high', label: t('settings.thinkingHigh') },
              ]}
            />
          </Row>
        </Group>
      </Column>
    </div>
  );
}

/** 一组设置。标题 + 说明 + 若干行 */
function Group({
  icon,
  title,
  desc,
  children,
}: {
  icon?: ReactNode;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-0.5 flex items-center gap-[7px]">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      </div>
      <div className="text-muted-foreground mb-2.5 text-[12.5px]">{desc}</div>
      <div className="border-border/60 border-t">{children}</div>
    </section>
  );
}

/**
 * 一行设置。左边名字 + 一句说明，右边控件。
 * 说明这一行是有意留出的：这些开关里有几个（尤其 AI 确认）关掉是有代价的，
 * 代价必须写在旁边，而不是等出了事再解释。
 */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="border-border/60 flex items-center gap-5 border-b px-0.5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-[13.5px]">{label}</div>
        {hint && (
          <div className="text-muted-foreground mt-0.5 text-xs leading-[17px]">{hint}</div>
        )}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}
