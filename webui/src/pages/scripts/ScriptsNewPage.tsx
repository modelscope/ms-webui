import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Play, Plus, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigFormShell } from '@/components/ConfigFormShell';
import type { ConfigField } from '@/components/PageAssistant';
import { Field, FieldStack, SegmentedControl, SelectInput } from '@/components/FormField';
import { TagInput } from '@/components/SearchSelect';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { MODULES } from '@/theme/modules';
import { listScripts, startScript } from '@/api/scripts';
import { fsTool } from '@/api/tools';
import { pushRecent } from '@/store/recent';
import { useT } from '@/i18n';

/** 贴进来的一个代码文件：文件名 + 内容 */
interface CodeFile {
  name: string;
  content: string;
}

/**
 * 新建脚本任务。两种来源：「已有脚本」填工作空间路径（文件或多文件目录，
 * 目录按 main.py / run.py / __main__.py 找入口）；「贴代码」直接粘贴或从本地
 * 选文件，可多个，先写进工作空间再执行。执行是后台任务：不限时长，日志
 * 实时可看，随时停。
 */
export function ScriptsNewPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  /* 模板克隆入口：列表/详情「以此为模板新建」带 ?from=<任务 id> 回填 */
  const from = searchParams.get('from');
  const [mode, setMode] = useState<'existing' | 'paste'>('existing');
  const [script, setScript] = useState('');
  /* 贴代码：目标目录 + 文件列表 + 入口 */
  const [dir, setDir] = useState(`scripts/run-${Date.now().toString(36)}`);
  const [files, setFiles] = useState<CodeFile[]>([{ name: 'main.py', content: '' }]);
  const [entry, setEntry] = useState('main.py');
  const [args, setArgs] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!from) return;
    listScripts()
      .then((tasks) => {
        const t = tasks.find((x) => x.id === from);
        if (!t) return; /* 内存任务表重启即清：静默退化为普通新建 */
        setScript(t.script);
        setArgs([...t.args]);
      })
      .catch(() => {
        /* 后端暂不可达：保持空表单 */
      });
  }, [from]);

  /* 入口文件候选：贴进来的 .py 文件 */
  const pyNames = files.map((f) => f.name).filter((n) => n.endsWith('.py'));
  useEffect(() => {
    if (pyNames.length && !pyNames.includes(entry)) setEntry(pyNames[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pyNames.join(',')]);

  const patchFile = (i: number, patch: Partial<CodeFile>) =>
    setFiles((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  /* 本地选文件读文本加入列表（同名覆盖内容） */
  const onUpload = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const f of Array.from(list)) {
      const content = await f.text();
      setFiles((prev) =>
        prev.some((x) => x.name === f.name)
          ? prev.map((x) => (x.name === f.name ? { ...x, content } : x))
          : [...prev, { name: f.name, content }],
      );
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const pasteScript = `${dir.trim()}/${entry}`;

  const preview = useMemo(() => {
    if (mode === 'paste') {
      const head = files.some((f) => f.content.trim())
        ? [
            t('sc.cmdWrite', { dir: dir.trim(), n: files.length }),
            ...files.map((f) => t('sc.cmdFile', { name: f.name, n: f.content.length })),
          ]
        : [t('sc.cmdEmptyPaste', { dir: dir.trim() })];
      return [...head, `python ${pasteScript}${args.length ? ` ${args.join(' ')}` : ''}`].join('\n');
    }
    return script.trim()
      ? `python ${script.trim()}${args.length ? ` ${args.join(' ')}` : ''}`
      : t('sc.cmdHint');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, script, dir, entry, files, args]);

  const submit = async () => {
    let scriptPath = '';
    if (mode === 'existing') {
      if (!script.trim()) {
        toast.error(t('sc.errPath'));
        return;
      }
      scriptPath = script.trim();
    } else {
      const bad = files.filter((f) => !f.name.trim());
      if (!files.length || bad.length) {
        toast.error(t('sc.errNames'));
        return;
      }
      if (!pyNames.length) {
        toast.error(t('sc.errPy'));
        return;
      }
      if (!dir.trim()) {
        toast.error(t('sc.errDir'));
        return;
      }
      scriptPath = pasteScript;
    }
    setSubmitting(true);
    try {
      /* 贴代码：先把文件写进工作空间（同名文件会被覆盖），再启动 */
      if (mode === 'paste') {
        for (const f of files) {
          await fsTool({ op: 'write', path: `${dir.trim()}/${f.name.trim()}`, content: f.content });
        }
      }
      const id = await startScript(scriptPath, args.length ? args : undefined);
      pushRecent({
        id: `scripts:${id}`,
        label: name.trim() || t('sc.taskLabel', { path: scriptPath }),
        path: `/scripts/${id}/log`,
      });
      toast.success(t('sc.started'));
      navigate('/scripts');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const fields: ConfigField[] = [
    {
      key: 'script',
      label: t('sc.script'),
      value: mode === 'paste' ? pasteScript : script,
      apply: mode === 'paste' ? (v) => setDir(v.trim().replace(/\/[^/]*$/, '')) : setScript,
    },
    { key: 'args', label: t('sc.args'), value: args.join(' '), apply: (v) => setArgs(v.split(/[\s,]+/).filter(Boolean)) },
  ];

  return (
    <ConfigFormShell
      module={MODULES.scripts}
      title={t('sc.newScript')}
      desc={t('sc.desc')}
      preview={preview}
      fields={fields}
      actions={
        <Button onClick={() => void submit()} disabled={submitting}>
          <Play /> {submitting ? t('tn.launching') : t('sc.launchBtn')}
        </Button>
      }
      sections={[
        {
          title: t('sc.secSource'),
          content: (
            <FieldStack>
              <Field label={t('sc.fromLabel')}>
                <SegmentedControl
                  value={mode}
                  onChange={(v) => setMode(v as 'existing' | 'paste')}
                  options={[
                    { value: 'existing', label: t('sc.optExisting') },
                    { value: 'paste', label: t('sc.optPaste') },
                  ]}
                />
              </Field>
              {mode === 'existing' && (
                <Field label={t('sc.pathLabel')} hint={t('sc.pathHint')}>
                  <Input
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder={t('sc.pathPh')}
                    className="h-8 font-mono text-[13px]"
                  />
                </Field>
              )}
              {mode === 'paste' && (
                <>
                  <Field label={t('sc.dirLabel')} hint={t('sc.dirHint')}>
                    <Input
                      value={dir}
                      onChange={(e) => setDir(e.target.value)}
                      className="h-8 font-mono text-[13px]"
                    />
                  </Field>
                  <div className="flex flex-col gap-2.5">
                    {files.map((f, i) => (
                      <div key={i} className="border-border/60 rounded-lg border p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <Input
                            value={f.name}
                            onChange={(e) => patchFile(i, { name: e.target.value })}
                            placeholder="main.py"
                            className="h-8 w-64 font-mono text-[13px]"
                          />
                          {files.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('sc.delFile')}
                              className="text-muted-foreground"
                              onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                            >
                              <X size={14} />
                            </Button>
                          )}
                        </div>
                        <Textarea
                          value={f.content}
                          onChange={(e) => patchFile(i, { content: e.target.value })}
                          placeholder={t('sc.codePh')}
                          className="min-h-[160px] font-mono text-[13px]"
                        />
                      </div>
                    ))}
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFiles((prev) => [...prev, { name: `part${prev.length}.py`, content: '' }])}
                      >
                        <Plus size={13} /> {t('sc.addFile')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                        <Upload size={13} /> {t('sc.uploadFile')}
                      </Button>
                      <input
                        ref={fileRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => void onUpload(e.target.files)}
                      />
                    </div>
                    {pyNames.length > 1 && (
                      <Field label={t('sc.entryLabel')} hint={t('sc.entryHint')}>
                        <SelectInput
                          value={entry}
                          onChange={setEntry}
                          options={pyNames.map((n) => ({ value: n, label: n }))}
                          className="w-64"
                        />
                      </Field>
                    )}
                  </div>
                </>
              )}
            </FieldStack>
          ),
        },
        {
          title: t('sc.secRun'),
          content: (
            <FieldStack>
              <Field label={t('sc.args')} hint={t('sc.argsHint')}>
                <TagInput values={args} onChange={setArgs} options={[]} placeholder="--data a.jsonl --limit 100" />
              </Field>
              <Field label={t('sc.nameLabel')} hint={t('sc.nameHint')}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('sc.namePh')}
                  className="h-8 text-[13px]"
                />
              </Field>
            </FieldStack>
          ),
        },
      ]}
    />
  );
}
