"""
name: error_driven
desc: 失败案例驱动的数据增强——从评测失败样本生成针对性新训练数据（课程学习式迭代）
usage: python error_driven.py --train-data <训练jsonl> --failures <失败案例jsonl> --out <新版本目录> [--strategy rewrite|paraphrase|scaffold] [--factor 2]
guards: 评测集隔离（--eval-root 声明的评测目录，任何输入路径落在里面直接拒绝）；输出必须是不存在的新目录；行级 schema 校验 + 去重
"""

import argparse
import json
import os
import sys


def fail(msg: str) -> None:
    print(f"[error_driven] REFUSED: {msg}", file=sys.stderr)
    sys.exit(2)


def guard_paths(paths: list, eval_root: str) -> None:
    """评测集冻结：任何输入落在评测目录内直接拒绝（realpath 防符号链接绕过）。"""
    if not eval_root:
        return
    root = os.path.realpath(eval_root)
    for p in paths:
        if os.path.realpath(p).startswith(root + os.sep):
            fail(f"输入 {p} 落在评测集目录 {eval_root} 内——评测集冻结，生成组件不得读取")


def load_jsonl(path: str) -> list:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def valid_row(row: dict) -> bool:
    """messages 形态的行级 schema 校验：非空 {role, content} 列表。"""
    msgs = row.get("messages")
    return (
        isinstance(msgs, list)
        and len(msgs) > 0
        and all(
            isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str) and m["content"]
            for m in msgs
        )
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="error-driven data augmentation for autoresearch")
    ap.add_argument("--train-data", required=True, help="上一版训练数据 jsonl（messages 格式）")
    ap.add_argument("--failures", required=True, help="评测失败案例 jsonl（含问题与错误输出/期望答案）")
    ap.add_argument("--out", required=True, help="新版本数据目录（必须不存在——组件拒绝覆盖旧版本）")
    ap.add_argument("--strategy", default="rewrite", choices=["rewrite", "paraphrase", "scaffold"],
                    help="增强策略：rewrite=围绕失败案例改写生成；paraphrase=同义改写防过拟合；scaffold=给失败模式加示范轮")
    ap.add_argument("--factor", type=int, default=2, help="每个失败案例生成的近邻变体数")
    ap.add_argument("--eval-root", default="", help="冻结评测集目录（给了它，任何输入落在里面直接拒绝）")
    args = ap.parse_args()

    # 护栏 1：输出必须是不存在的新目录（不覆盖任何旧版本）
    if os.path.exists(args.out):
        fail(f"输出目录已存在: {args.out}（数据版本只增不改，换一个新的版本目录名）")

    # 护栏 2：评测集冻结——输入不得落在评测目录里
    guard_paths([args.train_data, args.failures], args.eval_root)
    train_rows = load_jsonl(args.train_data)
    failure_rows = load_jsonl(args.failures)

    out_rows = []
    seen_keys = set()
    for row in train_rows:
        key = json.dumps(row.get("messages"), ensure_ascii=False, sort_keys=True)
        if key not in seen_keys:
            seen_keys.add(key)
            out_rows.append(row)

    """
    生成逻辑的接缝：模板内只做确定性的「结构级」增强（去重、失败案例回灌为
    新训练行、按 strategy 组织示范轮）。语义级改写需要模型参与时，请在
    workspace 副本里继承本组件、替换 generate_variants()，护栏函数
    （guard_paths / valid_row / 新目录强制）不要动。
    """

    def failure_to_row(f: dict) -> dict:
        """失败案例 → 一条训练行。期望答案成为 assistant 轮（教模型做对）。"""
        question = f.get("question") or f.get("query") or f.get("prompt") or ""
        expected = f.get("expected") or f.get("answer") or f.get("ground_truth") or ""
        if not question or not expected:
            return {}
        msgs = [{"role": "user", "content": str(question)}]
        if args.strategy == "scaffold":
            msgs.insert(0, {"role": "system", "content": "仔细分析问题后逐步作答。"})
        msgs.append({"role": "assistant", "content": str(expected)})
        return {"messages": msgs}

    def generate_variants(row: dict) -> list:
        """确定性变体：默认策略只回灌原行（占位接缝，见上方说明）。"""
        return [row]

    for f in failure_rows:
        base = failure_to_row(f)
        if not base:
            continue
        for v in range(max(1, args.factor)):
            for candidate in generate_variants(base):
                if not valid_row(candidate):
                    continue
                key = json.dumps(candidate.get("messages"), ensure_ascii=False, sort_keys=True)
                if key not in seen_keys:
                    seen_keys.add(key)
                    out_rows.append(candidate)

    out_rows = [r for r in out_rows if valid_row(r)]
    if not out_rows:
        fail("增强后没有合法行（检查输入格式是否为 messages 形态）")

    os.makedirs(args.out, exist_ok=False)
    out_file = os.path.join(args.out, "train.jsonl")
    with open(out_file, "w", encoding="utf-8") as f:
        for r in out_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[error_driven] 基线 {len(train_rows)} 行 + 失败驱动增强 → {len(out_rows)} 行，写出 {out_file}")


if __name__ == "__main__":
    main()
