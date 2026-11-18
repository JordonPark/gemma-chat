#!/usr/bin/env python3
"""
GGUF 모델 용량 줄이기 도구 (llama.cpp 의 gguf-py 사용).

  inspect <model.gguf>             텐서 형식별 개수·용량, 토큰 임베딩 형식
  shrink  <in.gguf> <out.gguf>     토큰 임베딩만 Q8_0 로 바꾸고, 나머지 텐서·메타데이터는 바이트 그대로 복사
  diff    <a.gguf> <b.gguf>        텐서별로 형식·데이터가 바뀐 개수

Gemma 3 QAT Q4_0 GGUF 는 본문 가중치가 4bit 인데 토큰 임베딩(262144 x 2560)은 16bit 라 1.3GB 를 차지한다.
임베딩만 Q8_0(약 8.5bit)로 바꾸면 약 0.6GB 가 줄고, 나머지는 원본과 완전히 같다.
"""
import hashlib
import os
import sys

import numpy as np
import gguf
from gguf import quants

EMBED = "token_embd.weight"


def inspect(path: str) -> None:
    r = gguf.GGUFReader(path)
    by_type: dict[str, list[int]] = {}
    for t in r.tensors:
        k = t.tensor_type.name
        by_type.setdefault(k, [0, 0])
        by_type[k][0] += 1
        by_type[k][1] += int(t.n_bytes)
        if t.name == EMBED:
            print(f"embed={t.tensor_type.name} {int(t.n_bytes) / 1e6:.0f}MB shape={list(t.shape)}")
    print("types=" + ", ".join(f"{k}:{c}x/{b / 1e6:.0f}MB" for k, (c, b) in sorted(by_type.items())))
    print(f"file={os.path.getsize(path) / 1e9:.3f}GB")


def shrink(src: str, dst: str) -> None:
    r = gguf.GGUFReader(src)
    arch = r.fields[gguf.Keys.General.ARCHITECTURE].contents()
    w = gguf.GGUFWriter(dst, arch=arch, endianess=r.endianess)

    # 메타데이터 그대로 복사 (llama.cpp gguf_new_metadata.py 와 같은 방식)
    for field in r.fields.values():
        if field.name == gguf.Keys.General.ARCHITECTURE or field.name.startswith("GGUF."):
            continue
        val_type = field.types[0]
        sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
        w.add_key_value(field.name, field.contents(), val_type, sub_type=sub_type)

    new_data: dict[str, np.ndarray] = {}
    for t in r.tensors:
        if t.name == EMBED and t.tensor_type not in (gguf.GGMLQuantizationType.Q8_0,):
            f32 = quants.dequantize(t.data, t.tensor_type).astype(np.float32)
            q = quants.quantize(f32, gguf.GGMLQuantizationType.Q8_0)
            del f32
            new_data[t.name] = q
            w.add_tensor_info(t.name, q.shape, q.dtype, q.nbytes, gguf.GGMLQuantizationType.Q8_0)
            print(f"{t.name}: {t.tensor_type.name} {int(t.n_bytes) / 1e6:.0f}MB -> Q8_0 {q.nbytes / 1e6:.0f}MB")
        else:
            w.add_tensor_info(t.name, t.data.shape, t.data.dtype, t.data.nbytes, t.tensor_type)

    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_ti_data_to_file()
    for t in r.tensors:
        w.write_tensor_data(new_data.get(t.name, t.data), tensor_endianess=r.endianess)
    w.close()


def diff(a: str, b: str) -> None:
    ra, rb = gguf.GGUFReader(a), gguf.GGUFReader(b)
    tb = {t.name: t for t in rb.tensors}
    changed_type, changed_data, same = [], 0, 0
    for t in ra.tensors:
        u = tb.get(t.name)
        if u is None:
            changed_type.append(f"{t.name}:missing")
        elif u.tensor_type != t.tensor_type:
            changed_type.append(f"{t.name}:{t.tensor_type.name}->{u.tensor_type.name}")
        elif hashlib.sha1(np.ascontiguousarray(t.data).tobytes()).digest() != hashlib.sha1(np.ascontiguousarray(u.data).tobytes()).digest():
            changed_data += 1
        else:
            same += 1
    print(f"identical={same} type_changed={len(changed_type)} data_changed_same_type={changed_data}")
    if changed_type:
        print("type_changes=" + "; ".join(changed_type[:6]))


if __name__ == "__main__":
    cmd = sys.argv[1]
    {"inspect": lambda: inspect(sys.argv[2]), "shrink": lambda: shrink(sys.argv[2], sys.argv[3]), "diff": lambda: diff(sys.argv[2], sys.argv[3])}[cmd]()
