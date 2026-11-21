#!/usr/bin/env python3
"""Offline Japanese furigana annotator using SudachiPy (local, zero network).

Protocol (NDJSON over stdin/stdout):
  Request:  {"id": 1, "text": "気付かれないでトドメを刺す"}
  Response: {"id": 1, "segments": [["気付", "きづ"], ["かれないでトドメを", ""], ["刺", "さ"], ["す", ""]]}

  Batch request:  {"id": 2, "texts": ["...", "..."]}
  Batch response: {"id": 2, "results": [[...], [...]]}

CLI check:
  python3 service/furigana.py --check
"""

import json
import re
import sys

KANJI_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\u3005]')
KANA_RE = re.compile(r'[\u3041-\u3096\u30a1-\u30f6\u30fc]')


def katakana_to_hiragana(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return ''.join(out)


def _is_kana(ch: str) -> bool:
    return bool(KANA_RE.match(ch))


def _is_kanji_like(ch: str) -> bool:
    # Include ヶ/ヵ only when adjacent to kanji (handled in ruby_segments),
    # and always include CJK Unified Ideographs + iteration mark 々.
    return bool(KANJI_RE.match(ch))


def ruby_segments(surface: str, hiragana: str) -> list[list[str]]:
    """Split one kanji-bearing morpheme into [text, reading] pairs so furigana
    sit only over the kanji characters and never over okurigana:
      忘れ物 + わすれもの -> [['忘', 'わす'], ['れ', ''], ['物', 'もの']]
      気付か + きづか     -> [['気付', 'きづ'], ['か', '']]
      一ヶ月 + いっかげつ -> [['一ヶ月', 'いっかげつ']]
    Always preserves every character of `surface` in order.
    """
    if not hiragana or hiragana == '*' or not KANJI_RE.search(surface):
        return [[surface, '']]

    runs: list[list[str]] = []
    for ch in surface:
        if _is_kanji_like(ch):
            kind = 'kanji'
        elif _is_kana(ch):
            kind = 'kana'
        else:
            kind = 'other'
        if runs and runs[-1][1] == kind:
            runs[-1][0] += ch
        else:
            runs.append([ch, kind])

    # Keep small counter ヶ/ヵ or middle marks inside kanji compounds together
    # (e.g. 一ヶ月 -> いっかげつ).
    for idx in range(len(runs) - 2, 0, -1):
        text, kind = runs[idx]
        if runs[idx - 1][1] == 'kanji' and runs[idx + 1][1] == 'kanji' and text in ('ヶ', 'ヵ', 'ケ'):
            runs[idx - 1][0] += text + runs[idx + 1][0]
            del runs[idx:idx + 2]

    # Peel off leading/trailing punctuation/spaces that dictionary readings omit
    # (e.g. full-dict title entry "君の名は。" whose reading is "きみのなは").
    prefix: list[list[str]] = []
    suffix: list[list[str]] = []
    while runs and runs[0][1] == 'other' and not hiragana.startswith(runs[0][0]):
        prefix.append([runs.pop(0)[0], ''])
    while runs and runs[-1][1] == 'other' and not hiragana.endswith(runs[-1][0]):
        suffix.insert(0, [runs.pop()[0], ''])

    if not any(kind == 'kanji' for _, kind in runs):
        return [[surface, '']]

    pattern = ''.join(
        '(.+?)' if kind == 'kanji'
        else re.escape(katakana_to_hiragana(text)) if kind == 'kana'
        else re.escape(text)
        for text, kind in runs
    )
    match = re.fullmatch(pattern, hiragana)
    if not match:
        # Irregular / ateji reading where okurigana differs from dictionary reading:
        # only annotate the core if reading is valid kana and differs from core.
        core = ''.join(text for text, _ in runs)
        if all(_is_kana(ch) for ch in hiragana) and katakana_to_hiragana(core) != hiragana:
            return prefix + [[core, hiragana]] + suffix
        return [[surface, '']]

    group = 0
    result: list[list[str]] = list(prefix)
    for text, kind in runs:
        if kind == 'kanji':
            group += 1
            reading = match.group(group)
            result.append([text, reading if reading != text else ''])
        else:
            result.append([text, ''])
    result.extend(suffix)
    return result


def load_tokenizer():
    from sudachipy import Dictionary, SplitMode  # type: ignore

    last_err = None
    for dict_type in ('full', 'core', 'small'):
        try:
            dic = Dictionary(dict=dict_type)
            tok = dic.tokenizer() if hasattr(dic, 'tokenizer') else dic.create()
            return tok, SplitMode.C, dict_type
        except Exception as err:
            last_err = err
    raise RuntimeError(f'No Sudachi dictionary installed ({last_err})')


def annotate_text(tokenizer, split_mode, text: str) -> list[list[str]]:
    if not text or not KANJI_RE.search(text):
        return [[text, '']] if text else []

    raw_segments: list[list[str]] = []
    for morpheme in tokenizer.tokenize(text, split_mode):
        surface = morpheme.surface()
        if not surface:
            continue
        if not KANJI_RE.search(surface):
            raw_segments.append([surface, ''])
            continue
        reading_kata = morpheme.reading_form() or ''
        reading_hira = katakana_to_hiragana(reading_kata)
        raw_segments.extend(ruby_segments(surface, reading_hira))

    # Merge adjacent plain segments (reading == '') for compact payloads.
    merged: list[list[str]] = []
    for seg_text, seg_reading in raw_segments:
        if not seg_text:
            continue
        if seg_reading == '' and merged and merged[-1][1] == '':
            merged[-1][0] += seg_text
        else:
            merged.append([seg_text, seg_reading])

    # Invariant: concatenated base text always matches input exactly.
    if ''.join(seg[0] for seg in merged) != text:
        return [[text, '']]
    return merged


def main() -> int:
    try:
        tokenizer, split_mode, dict_type = load_tokenizer()
    except Exception as err:
        msg = f'sudachipy unavailable: {err}'
        if '--check' in sys.argv:
            print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))
            return 1
        print(json.dumps({'ready': False, 'error': msg}, ensure_ascii=False), flush=True)
        return 1

    if '--check' in sys.argv:
        print(json.dumps({'ok': True, 'dict': dict_type}, ensure_ascii=False))
        return 0

    print(json.dumps({'ready': True, 'dict': dict_type}, ensure_ascii=False), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            req = json.loads(raw_line)
            req_id = req.get('id')
            if 'texts' in req and isinstance(req['texts'], list):
                results = [annotate_text(tokenizer, split_mode, str(t)) for t in req['texts']]
                resp = {'id': req_id, 'results': results}
            else:
                segments = annotate_text(tokenizer, split_mode, str(req.get('text', '')))
                resp = {'id': req_id, 'segments': segments}
        except Exception as err:
            resp = {'id': None, 'error': str(err)}
        print(json.dumps(resp, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
