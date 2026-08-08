#!/usr/bin/env python3
"""扫描 CSS 中所有 var(--x) 引用，找出「引用但未定义」的幽灵变量。

回归检查用途：每次修改 style.css 后运行，结果应为 0 幽灵变量。
不要只靠肉眼 grep 定义缺失——已定义的变量（如 --brand-light、
--text-secondary）容易被误判为未定义。脚本用「定义集合 ∩ 引用集合差集」精确判定。

用法：
    python3 check_css_vars.py                 # 默认检查 public/style.css
    python3 check_css_vars.py path/to/a.css  # 指定文件
退出码：0 = 无幽灵变量；1 = 存在未定义变量
"""
import re
import sys

DEFAULT = 'public/style.css'


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    txt = open(path, encoding='utf-8').read()

    # 所有定义：形如 --name: value（含媒体查询/主题块内的定义）
    defs = {d[:-1].strip() for d in re.findall(r'--[a-zA-Z0-9-]+\s*:', txt)}
    # 所有引用：形如 var(--name)
    refs = re.findall(r'var\((--[a-zA-Z0-9-]+)\)', txt)
    ref_set = set(refs)
    undef = sorted(ref_set - defs)

    print(f"已定义变量: {len(defs)}  引用变量: {len(ref_set)}  幽灵变量: {len(undef)}")
    if undef:
        for u in undef:
            lines = [str(i + 1) for i, l in enumerate(txt.splitlines()) if f'var({u})' in l]
            print(f"  {u} -> 行 {','.join(lines)}")
        sys.exit(1)
    print("OK：无引用未定义的 CSS 变量")


if __name__ == '__main__':
    main()
