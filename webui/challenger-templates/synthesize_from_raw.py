"""
name: synthesize_from_raw
desc: 原始数据再加工——从用户的原始数据（只读探查过的）采样/过滤/格式变换出新训练数据版本
usage: python synthesize_from_raw.py --raw <原始数据jsonl/csv> --out <新版本目录> [--limit N] [--offset N] [--where <python布尔表达式>]
guards: 输出必须是不存在的新目录；行级 schema 校验；--where 只允许引用行内字段（无 import/eval 任意代码）
"""

import argparse
import csv
import json
import os
import sys


def fail(msg: str) -> None:
    print(f"[synthesize_from_raw] REFUSED: {msg}", file=sys.stderr)
    sys.exit(2)


def valid_row(row: dict) -> bool:
    msgs = row.get("messages")
    return (
        isinstance(msgs, list)
        and len(msgs) > 0
        and all(
            isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str) and m["content"]
            for m in msgs
        )
    )


def load_rows(path: str) -> list:
    """jsonl（messages 形态或 query/response 双列）或 csv（表头行）两种入口。"""
    rows = []
    if path.endswith(".csv"):
        with open(path, "r", encoding="utf-8", newline="") as f:
            for rec in csv.DictReader(f):
                q = rec.get("query") or rec.get("question") or rec.get("prompt")
                a = rec.get("response") or rec.get("answer")
                if q and a:
                    rows.append({"messages": [{"role": "user", "content": q}, {"role": "assistant", "content": a}]})
    else:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if "messages" in rec:
                    rows.append(rec)
                else:
                    q = rec.get("query") or rec.get("question") or rec.get("prompt")
                    a = rec.get("response") or rec.get("answer")
                    if q and a:
                        rows.append({"messages": [{"role": "user", "content": str(q)}, {"role": "assistant", "content": str(a)}]})
    return rows


def make_filter(expr: str):
    """把 --where 编译成行内字段过滤器。只允许引用 row 的字段名（标识符），杜绝任意代码。"""
    import re

    if not expr:
        return None
    if not re.fullmatch(r"[\w\s().<>=!+\-*/%'\"]+", expr):
        fail(f"--where 含不允许的字符: {expr}")
    names = set(re.findall(r"[A-Za-z_]\w*", expr)) - {"and", "or", "not", "in", "len", "str", "int", "float", "True", "False", "None"}
    code = compile(expr, "<where>", "eval")

    def check(row: dict) -> bool:
        env = {k: row.get(k) for k in names}
        return bool(eval(code, {"__builtins__": {}}, env))  # noqa: S307

    return check


def main() -> None:
    ap = argparse.ArgumentParser(description="raw-data resampling / filtering / format conversion")
    ap.add_argument("--raw", required=True, help="原始数据文件（jsonl 或 csv）")
    ap.add_argument("--out", required=True, help="新版本数据目录（必须不存在）")
    ap.add_argument("--limit", type=int, default=0, help="最多取前 N 行（0 = 全量）")
    ap.add_argument("--offset", type=int, default=0, help="跳过前 N 行")
    ap.add_argument("--where", default="", help="行内字段布尔表达式（如 \"len(query) > 20\"），只引用行内字段")
    args = ap.parse_args()

    # 护栏：输出必须是不存在的新目录（数据版本只增不改）
    if os.path.exists(args.out):
        fail(f"输出目录已存在: {args.out}（数据版本只增不改，换一个新目录名）")

    rows = load_rows(args.raw)
    flt = make_filter(args.where)
    picked = rows[args.offset:] if args.offset else rows
    if flt:
        picked = [r for r in picked if flt(r)]
    if args.limit > 0:
        picked = picked[: args.limit]
    picked = [r for r in picked if valid_row(r)]
    if not picked:
        fail("过滤后没有合法行（放宽 --where 或检查数据格式）")

    os.makedirs(args.out, exist_ok=False)
    out_file = os.path.join(args.out, "train.jsonl")
    with open(out_file, "w", encoding="utf-8") as f:
        for r in picked:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[synthesize_from_raw] 原始 {len(rows)} 行 → 取 {len(picked)} 行，写出 {out_file}")


if __name__ == "__main__":
    main()
