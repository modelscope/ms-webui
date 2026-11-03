"""
name: judge
desc: custom metric 判分组件——对模型输出按规则或 LLM rubric 打分，产出 autoresearch 可机械消费的分数 jsonl
usage: python judge.py --pred <模型输出jsonl> --rubric <评分规则文件> --out <分数jsonl> [--mode rule|llm] [--api-base URL --api-key KEY --model NAME]
guards: 只读输入、分数只增不覆盖旧文件（--out 必须不存在）；rule 模式无网络；llm 模式逐条请求并带超时
"""

import argparse
import json
import os
import sys


def fail(msg: str) -> None:
    print(f"[judge] REFUSED: {msg}", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    ap = argparse.ArgumentParser(description="custom-metric judge for autoresearch")
    ap.add_argument("--pred", required=True, help="模型输出 jsonl（每行含 question/prediction/expected 之类字段）")
    ap.add_argument("--rubric", required=True, help="评分规则文件：rule 模式是 JSON（字段映射与规则）；llm 模式是 rubric 文本")
    ap.add_argument("--out", required=True, help="分数输出 jsonl（必须不存在）")
    ap.add_argument("--mode", default="rule", choices=["rule", "llm"], help="rule=确定性规则打分；llm=模型按 rubric 打分")
    ap.add_argument("--api-base", default="", help="llm 模式：OpenAI 兼容 base url")
    ap.add_argument("--api-key", default="", help="llm 模式：API key")
    ap.add_argument("--model", default="", help="llm 模式：模型名")
    args = ap.parse_args()

    # 护栏：分数文件只增不覆盖
    if os.path.exists(args.out):
        fail(f"输出文件已存在: {args.out}（换一个新文件名——分数是账本，不允许覆盖）")
    with open(args.pred, "r", encoding="utf-8") as f:
        rows = [json.loads(l) for l in f if l.strip()]
    with open(args.rubric, "r", encoding="utf-8") as f:
        rubric = f.read().strip()
    if not rows:
        fail("pred 文件为空")

    results = []
    if args.mode == "rule":
        """rule 模式：rubric 是 JSON，最小形态 {"expect": "expected"}（字段名映射到预测行；
        相等即 1 否则 0）。更复杂的规则请继承本组件改 judge_row。"""
        spec = json.loads(rubric)
        expect_field = spec.get("expect", "expected")
        pred_field = spec.get("predict", "prediction")

        def judge_row(row: dict) -> float:
            try:
                return 1.0 if str(row.get(expect_field)).strip() == str(row.get(pred_field)).strip() else 0.0
            except Exception:
                return 0.0

        for row in rows:
            results.append({"score": judge_row(row), "row": row})
    else:
        """llm 模式：每行发一次请求，让模型按 rubric 给 0-1 分。逐条容错（失败记 null），
        最终分 = 非 null 行的均值；全部失败则报错退出（fail-loud，不出假分）。"""
        if not (args.api_base and args.model):
            fail("llm 模式需要 --api-base 与 --model")
        import urllib.request

        def judge_row(row: dict) -> float:
            payload = json.dumps(
                {
                    "model": args.model,
                    "messages": [
                        {"role": "system", "content": f"You are a strict grader. Rubric:\n{rubric}\nReply with a single number in [0,1]."},
                        {"role": "user", "content": json.dumps(row, ensure_ascii=False)},
                    ],
                    "max_tokens": 8,
                    "temperature": 0.0,
                }
            ).encode()
            req = urllib.request.Request(
                f"{args.api_base.rstrip('/')}/chat/completions",
                data=payload,
                headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {args.api_key}"} if args.api_key else {})},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read())
            return max(0.0, min(1.0, float(body["choices"][0]["message"]["content"].strip())))

        for row in rows:
            try:
                results.append({"score": judge_row(row), "row": row})
            except Exception as e:
                results.append({"score": None, "error": str(e), "row": row})

    scored = [r["score"] for r in results if r.get("score") is not None]
    if not scored:
        fail("没有任何一条判分成功（llm 模式全失败或 rule 规则异常）")
    overall = sum(scored) / len(scored)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.write(json.dumps({"overall": overall, "n": len(scored)}, ensure_ascii=False) + "\n")
    print(f"[judge] overall={overall:.4f}（{len(scored)}/{len(results)} 行判分成功），明细 {args.out}")


if __name__ == "__main__":
    main()
