/**
 * 行级 diff（对比页的代码差异块用）。
 *
 * 纯函数、无副作用：输入两份代码文本，输出逐行的差异序列。算法是教科书
 * LCS 动态规划——训练脚本只有几十到几百行，O(n*m) 完全够用，不需要
 * Myers 之类的优化。空行也参与比对（消融实验里改的往往就是某一行参数，
 * 行序必须稳定）；行尾的 \r 归一化掉（Windows 编辑器写出的文件）。
 */

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  type: DiffOp;
  text: string;
}

/** 按行拆分并归一化 \r：结尾无换行的最后一行也算一行 */
function toLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * base → target 的行级 diff。
 * 守恒律（对任意输入成立，验证脚本靠它断言正确性）：
 *   same + del 的条数 = base 行数；same + add 的条数 = target 行数。
 * 输出顺序：相同的行夹在中间，删除行在新增行之前（与 diff 工具的展示习惯一致）。
 */
export function diffLines(base: string, target: string): DiffLine[] {
  const a = toLines(base);
  const b = toLines(target);
  const n = a.length;
  const m = b.length;

  /* dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度 */
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}
