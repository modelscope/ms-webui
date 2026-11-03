/**
 * 训练表单的共享定义：字段清单（key = CLI flag 名）与代码模式模板。
 *
 * 从 TrainNewPage 抽出——New 页自身与 AI 预填（批二的 create_train 工具）
 * 共用同一份字段定义，保证「AI 工具的参数 schema」与「表单字段 key」单一来源。
 * eval/export/deploy 的同构定义各自一份，出现第二个使用方时再抽。
 *
 * 文案字段（label/hint/group）存 i18n key，渲染处 t() 取值；placeholder 以
 * CLI 默认值示例为主（'0.05'、'bfloat16'）保持原串，说明性文案走
 * placeholderKey。select 候选项的 label 多为 CLI 取值本身（dpo、local），
 * 中英一致的不建 key，需要翻译的补 labelKey。
 */
import type { MessageKey } from '@/i18n';

export type Tuner = 'lora' | 'full' | 'trainable_tokens';

/*
 * v5 训练命令面只有三个命令：sft（监督微调）/ pt（预训练）/ rl（偏好与
 * 强化学习）。dpo、grpo、gkd 等不是独立命令，是 `swift rl --rl_type <t>`
 * 的算法变体——RLConfig.rl_type 的 12 值 Literal，按家族分三组展示。
 */
export type TaskType = 'sft' | 'pt' | 'rl';

export const TASK_TYPE_DESC: Record<TaskType, MessageKey> = {
  sft: 'tf.descSft',
  pt: 'tf.descPt',
  rl: 'tf.descRl',
};

export const RL_TYPE_OPTIONS: { group: MessageKey; items: { value: string; label: string; labelKey?: MessageKey }[] }[] = [
  {
    group: 'rlg.offline',
    items: [
      { value: 'dpo', label: 'dpo' },
      { value: 'kto', label: 'kto' },
      { value: 'orpo', label: 'orpo' },
      { value: 'cpo', label: 'cpo' },
      { value: 'simpo', label: 'simpo' },
    ],
  },
  { group: 'rlg.rm', items: [{ value: 'rm', label: 'rm' }] },
  {
    group: 'rlg.online',
    items: [
      { value: 'grpo', label: 'grpo' },
      { value: 'ppo', label: 'ppo' },
      { value: 'rft', label: 'rft', labelKey: 'rlg.rft' },
    ],
  },
  { group: 'rlg.distill', items: [
    { value: 'gkd', label: 'gkd' },
    { value: 'opsd', label: 'opsd' },
    { value: 'mopd', label: 'mopd' },
  ] },
];

/*
 * 在线 RL 家族：rollout 走独立采样器（actor/sampler 双组配卡）；离线族
 * （dpo/kto/orpo/cpo/simpo/rm）无 sampler，单组即可。与 swift/dev/cli/rl.py
 * 的在线集合保持同步。
 */
export const ONLINE_RL_TYPES = ['grpo', 'ppo', 'rft', 'gkd', 'opsd', 'mopd'];

/**
 * 表单里的一条重要参数：key = CLI flag 名（后端 params 原样转 --key value）。
 * wide = 占整行的长输入（system 提示词、teacher_model 清单）；
 * 其余进三列自适应网格——数值参数占一格，默认值直接以 placeholder 灰字
 * 显示在输入框里，不填即走 CLI 默认。
 * kind 'list' = List[str] 型 flag（teacher_model）：值以空格 join 存进
 * params，后端按空格拆成多个 argv（HfArgumentParser 的 nargs 行为）。
 */
export interface ParamField {
  key: string;
  label: MessageKey;
  hint?: MessageKey;
  /** 输入框灰字：多为 CLI 默认值示例（'0.05'、'bfloat16'），保持原样 */
  placeholder?: string;
  /** placeholder 为说明性文案时的 i18n key（优先于 placeholder） */
  placeholderKey?: MessageKey;
  kind: 'number' | 'text' | 'bool' | 'list' | 'select' | 'password';
  wide?: boolean;
  /** kind='select' 时的候选项；value 即 CLI flag 的取值，labelKey 缺省时 label 原样展示 */
  options?: { value: string; label: string; labelKey?: MessageKey }[];
}

/*
 * 展览模式（SWIFT_WEBUI_MODE=expo）下训练锁 remote 时的默认 server 地址。
 * 展览部署的本机不跑训练进程，一律提交到远端 twinkle-server。
 */
export const EXPO_SERVER_URL = 'https://www.modelscope.cn/twinkle';

/*
 * 重要参数清单：legacy docs 标 🔥 的训练参数 + examples 高频项（lora_sft.sh /
 * full/train.sh）。分四组展示；不在清单里的参数走「将要执行」的附加参数直写。
 */
export const TRAIN_PARAMS: { group: MessageKey; fields: ParamField[] }[] = [
  {
    group: 'tf.groupRun',
    fields: [
      {
        key: 'mode',
        label: 'tf.mode',
        kind: 'select',
        placeholderKey: 'tf.modePh',
        options: [
          { value: 'local', label: 'local', labelKey: 'tf.optLocal' },
          { value: 'remote', label: 'twinkle-server' },
          { value: 'ray', label: 'ray' },
        ],
        hint: 'tf.modeHint',
      },
      /*
       * ray 档的 run 名（twinkle.initialize(name=...)，CLI 层仅 mode=ray 读取）：
       * 可选，用于在同一 ray 集群上区分多组任务的资源归属；不填走默认名。
       */
      {
        key: 'ray_exp_name',
        label: 'tf.rayExpName',
        kind: 'text',
        placeholderKey: 'tf.rayExpNamePh',
        hint: 'tf.rayExpNameHint',
      },
      {
        key: 'server_base_url',
        label: 'tf.serverUrl',
        kind: 'text',
        wide: true,
        placeholder: 'http://127.0.0.1:8000',
        hint: 'tf.serverUrlHint',
      },
      {
        key: 'server_api_key',
        label: 'tf.token',
        kind: 'password',
        wide: true,
        placeholderKey: 'tf.tokenPh',
        hint: 'tf.tokenHint',
      },
    ],
  },
  {
    group: 'tf.groupSeq',
    fields: [
      { key: 'torch_dtype', label: 'tf.dtype', kind: 'text', placeholder: 'bfloat16' },
      { key: 'max_length', label: 'tf.maxLength', kind: 'number', placeholder: '2048' },
      { key: 'system', label: 'tf.system', kind: 'text', wide: true, placeholderKey: 'tf.systemPh' },
    ],
  },
  {
    group: 'tf.groupData',
    fields: [
      { key: 'streaming', label: 'tf.streaming', kind: 'bool', hint: 'tf.streamingHint' },
      { key: 'lazy_tokenize', label: 'tf.lazyTokenize', kind: 'bool', hint: 'tf.lazyTokenizeHint' },
      { key: 'split_dataset_ratio', label: 'tf.splitRatio', kind: 'number', hint: 'tf.splitRatioHint', placeholder: '0' },
      { key: 'dataset_num_proc', label: 'tf.numProc', kind: 'number', hint: 'tf.numProcHint', placeholder: '1' },
      { key: 'shuffle_buffer_size', label: 'tf.shuffleBuffer', kind: 'number', hint: 'tf.shuffleBufferHint', placeholder: '1000' },
    ],
  },
  {
    group: 'tf.groupHparam',
    fields: [
      { key: 'learning_rate', label: 'tf.lr', kind: 'text', placeholder: 'lora 1e-4 / full 1e-5' },
      { key: 'num_train_epochs', label: 'tf.epochs', kind: 'number', placeholder: '3' },
      { key: 'per_device_train_batch_size', label: 'tf.batch', kind: 'number', placeholder: '1' },
      { key: 'gradient_accumulation_steps', label: 'tf.gradAccum', kind: 'number', placeholder: '16' },
      { key: 'warmup_ratio', label: 'tf.warmup', kind: 'text', placeholder: '0.05' },
      { key: 'packing', label: 'tf.packing', kind: 'bool', hint: 'tf.packingHint' },
    ],
  },
  {
    group: 'tf.groupSave',
    fields: [
      { key: 'save_steps', label: 'tf.saveSteps', kind: 'number', placeholder: '500' },
      { key: 'save_total_limit', label: 'tf.saveLimit', kind: 'number', placeholder: '2' },
      { key: 'logging_steps', label: 'tf.logSteps', kind: 'number', placeholder: '5' },
    ],
  },
];

/** LoRA 专有参数（tuner=lora 时展示；tuner 字段名是 dev 侧的 `--tuner`） */
export const LORA_PARAMS: ParamField[] = [
  { key: 'lora_rank', label: 'tf.loraRank', kind: 'number', placeholder: '8' },
  { key: 'lora_alpha', label: 'tf.loraAlpha', kind: 'number', placeholder: '32' },
  { key: 'target_modules', label: 'tf.targetModules', kind: 'text', wide: true, placeholderKey: 'tf.targetModulesPh' },
];

/*
 * 各 RL 算法的专有参数（RLConfig 分段镜像，key = flag 名）。只收各段的
 * 头部几个「调了就会明显改变行为」的旋钮；长尾（CHORD、f-divergence、
 * 重要性采样层等）走「将要执行」附加参数直写。注意两个结构事实：
 * opsd 是自蒸馏（教师 = 策略自身的特权 prompt 视图），没有 teacher_model
 * 且拒绝 beta；teacher_model 只有 gkd（恰一个）与 mopd（多个）才有。
 */
export const RL_PARAMS: Record<string, ParamField[]> = {
  dpo: [
    { key: 'beta', label: 'tf.beta', kind: 'number', hint: 'tf.betaHint', placeholder: '0.1' },
    { key: 'label_smoothing', label: 'tf.labelSmoothing', kind: 'number', placeholder: '0' },
    { key: 'rpo_alpha', label: 'tf.rpoAlpha', kind: 'number', hint: 'tf.rpoAlphaHint', placeholderKey: 'tf.offPh' },
    { key: 'ref_model', label: 'tf.refModel', kind: 'text', wide: true, hint: 'tf.refModelHint', placeholderKey: 'tf.refModelPh' },
  ],
  kto: [
    { key: 'beta', label: 'tf.beta', kind: 'number', placeholder: '0.1' },
    { key: 'desirable_weight', label: 'tf.desirableW', kind: 'number', placeholder: '1' },
    { key: 'undesirable_weight', label: 'tf.undesirableW', kind: 'number', placeholder: '1' },
    { key: 'ref_model', label: 'tf.refModel', kind: 'text', wide: true, placeholderKey: 'tf.refModelPh' },
  ],
  orpo: [
    { key: 'beta', label: 'tf.orpoBeta', kind: 'number', placeholder: '1' },
    { key: 'ref_model', label: 'tf.refModel', kind: 'text', wide: true, placeholderKey: 'tf.refModelPh' },
  ],
  cpo: [
    { key: 'beta', label: 'tf.beta', kind: 'number', placeholder: '0.1' },
    { key: 'cpo_alpha', label: 'tf.cpoAlpha', kind: 'number', placeholder: '1' },
    { key: 'simpo_gamma', label: 'tf.simpoGamma', kind: 'number', placeholder: '1' },
    { key: 'ref_model', label: 'tf.refModel', kind: 'text', wide: true, placeholderKey: 'tf.refModelPh' },
  ],
  simpo: [
    { key: 'simpo_gamma', label: 'tf.targetMargin', kind: 'number', placeholder: '1' },
    { key: 'cpo_alpha', label: 'tf.cpoAlpha', kind: 'number', placeholder: '1' },
  ],
  rm: [
    { key: 'center_rewards_coefficient', label: 'tf.centerRewards', kind: 'number', hint: 'tf.centerRewardsHint', placeholderKey: 'tf.offPh' },
    { key: 'ref_model', label: 'tf.refModel', kind: 'text', wide: true, placeholderKey: 'tf.refModelPh' },
  ],
  ppo: [
    { key: 'num_ppo_epochs', label: 'tf.ppoEpochs', kind: 'number', placeholder: '4' },
    { key: 'kl_coef', label: 'tf.klCoef', kind: 'number', placeholder: '0.05' },
    { key: 'cliprange', label: 'tf.cliprange', kind: 'number', placeholder: '0.2' },
    { key: 'vf_coef', label: 'tf.vfCoef', kind: 'number', placeholder: '0.1' },
    { key: 'max_completion_length', label: 'tf.maxCompletion', kind: 'number', placeholder: '512' },
  ],
  grpo: [
    { key: 'num_generations', label: 'tf.numGenerations', kind: 'number', hint: 'tf.numGenerationsHint', placeholder: '8' },
    { key: 'epsilon', label: 'tf.epsilon', kind: 'number', placeholder: '0.2' },
    { key: 'advantage_estimator', label: 'tf.advantageEstimator', kind: 'text', hint: 'tf.advantageEstimatorHint', placeholder: 'grpo' },
    { key: 'num_iterations', label: 'tf.numIterations', kind: 'number', placeholder: '1' },
    { key: 'max_completion_length', label: 'tf.maxCompletion', kind: 'number', placeholder: '512' },
  ],
  rft: [
    { key: 'rft_num_samples', label: 'tf.rftNumSamples', kind: 'number', hint: 'tf.rftNumSamplesHint', placeholderKey: 'tf.rftNumSamplesPh' },
    { key: 'rft_select', label: 'tf.rftSelect', kind: 'text', hint: 'tf.rftSelectHint', placeholder: 'best_of_n' },
    { key: 'rft_threshold', label: 'tf.rftThreshold', kind: 'number', hint: 'tf.rftThresholdHint', placeholder: '0' },
    { key: 'rft_iterations', label: 'tf.rftIterations', kind: 'number', hint: 'tf.rftIterationsHint', placeholder: '1' },
  ],
  gkd: [
    { key: 'teacher_model', label: 'tf.teacherModel', kind: 'list', wide: true, hint: 'tf.teacherModelHint' },
    { key: 'distill_temperature', label: 'tf.distillTemp', kind: 'number', hint: 'tf.distillTempHint', placeholder: '0.9' },
    { key: 'sft_alpha', label: 'tf.sftAlpha', kind: 'number', hint: 'tf.sftAlphaHint', placeholder: '0' },
    { key: 'lmbda', label: 'tf.lmbda', kind: 'number', hint: 'tf.lmbdaHint', placeholder: '0.5' },
    { key: 'offload_teacher_model', label: 'tf.offloadTeacher', kind: 'bool', hint: 'tf.offloadTeacherHint' },
  ],
  opsd: [
    { key: 'distill_temperature', label: 'tf.distillTemp', kind: 'number', placeholder: '0.9' },
    { key: 'lmbda', label: 'tf.lmbda', kind: 'number', hint: 'tf.opsdLmbdaHint', placeholder: '1' },
    { key: 'opsd_reverse', label: 'tf.opsdReverse', kind: 'bool', hint: 'tf.opsdReverseHint', placeholder: '' },
  ],
  mopd: [
    { key: 'teacher_model', label: 'tf.teacherModels', kind: 'list', wide: true, hint: 'tf.teacherModelsHint' },
    { key: 'teacher_weights', label: 'tf.teacherWeights', kind: 'text', wide: true, hint: 'tf.teacherWeightsHint', placeholderKey: 'tf.teacherWeightsPh' },
    { key: 'auxiliary_placement', label: 'tf.auxPlacement', kind: 'text', hint: 'tf.auxPlacementHint', placeholder: 'pack' },
    { key: 'distill_temperature', label: 'tf.distillTemp', kind: 'number', placeholder: '0.9' },
    { key: 'offload_teacher_model', label: 'tf.offloadTeacher', kind: 'bool', hint: 'tf.offloadTeacherHint' },
  ],
};

export const ALL_PARAMS = [...TRAIN_PARAMS.flatMap((g) => g.fields), ...LORA_PARAMS, ...Object.values(RL_PARAMS).flat()];

/**
 * 代码模式的默认模板：swift.dev Python 原生 API 的最小可跑样例（LoRA SFT）。
 * 与 `swift sft` CLI 同一条链路；Config 的全部旋钮见 swift/dev/config/*.py。
 */
export const CODE_TRAIN_TEMPLATE = `# 代码模式训练：swift.dev 的 Python 原生 API，与 \`swift sft\` 命令行走同一条链路。
# 适合表单放不下的场景：自定义训练循环、多阶段流水、代码内声明并行规格等。
# 各 Config 的全部旋钮见 swift/dev/config/*.py 的 dataclass 注释。
from swift.dev.config import (
    CheckpointConfig,
    DatasetConfig,
    DistributedConfig,
    ModelConfig,
    TemplateConfig,
    TrainConfig,
    TunerConfig,
)
from swift.dev.recipe.sft import run_sft

run_sft(
    model_config=ModelConfig(model='Qwen/Qwen2.5-0.5B-Instruct'),
    template_config=TemplateConfig(max_length=2048),
    dataset_config=DatasetConfig(dataset=['AI-ModelScope/alpaca-gpt4-data-zh']),
    train_config=TrainConfig(
        num_train_epochs=1,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=16,
    ),
    distributed_config=DistributedConfig(),
    checkpoint_config=CheckpointConfig(save_steps=500, save_total_limit=2),
    tuner_config=TunerConfig(tuner='lora'),
)
`;
