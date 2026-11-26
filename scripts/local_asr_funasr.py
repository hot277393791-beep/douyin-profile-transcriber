import argparse
import json
import os
import re
import sys
import time
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Batch local ASR with FunASR/SenseVoice.")
    parser.add_argument("--manifest", required=True, help="JSONL manifest: id,url,title,wav_path")
    parser.add_argument("--output", required=True, help="JSONL output file")
    parser.add_argument("--model", default="iic/SenseVoiceSmall")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--language", default="zh")
    parser.add_argument("--hotwords", default="")
    parser.add_argument("--batch-size-s", type=int, default=60)
    parser.add_argument("--merge-length-s", type=int, default=15)
    return parser.parse_args()


def clean_text(text):
    text = text or ""
    # SenseVoice may emit language/emotion/audio-event tags. They are useful for
    # debugging, but noisy for copywriting teardown.
    text = re.sub(r"<\|[^|]+?\|>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.replace(" ,", "，").replace(" .", "。")
    return text


def flatten_result(result):
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        return result.get("text") or result.get("sentence_info") or ""
    if isinstance(result, list):
        parts = []
        for item in result:
            if isinstance(item, dict):
                if item.get("text"):
                    parts.append(str(item["text"]))
                elif item.get("sentence_info"):
                    for sentence in item["sentence_info"]:
                        if isinstance(sentence, dict) and sentence.get("text"):
                            parts.append(str(sentence["text"]))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(result)


def choose_device(requested):
    if requested != "auto":
        return "cuda:0" if requested == "cuda" else "cpu"
    try:
        import torch

        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def read_manifest(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def append_jsonl(path, item):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")
        f.flush()


def main():
    args = parse_args()
    manifest = read_manifest(args.manifest)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    cache_root = os.environ.get("LOCAL_ASR_CACHE")
    if cache_root:
        Path(cache_root).mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("MODELSCOPE_CACHE", str(Path(cache_root) / "modelscope"))
        os.environ.setdefault("HF_HOME", str(Path(cache_root) / "huggingface"))

    try:
        from funasr import AutoModel
    except Exception as exc:
        print(
            json.dumps(
                {
                    "fatal": True,
                    "error": f"FunASR import failed: {exc}",
                    "hint": "Install funasr, modelscope, torch and torchaudio in the selected Python environment.",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    device = choose_device(args.device)
    print(json.dumps({"event": "load_model", "model": args.model, "device": device}, ensure_ascii=False), flush=True)
    model = AutoModel(
        model=args.model,
        vad_model=args.vad_model,
        vad_kwargs={"max_single_segment_time": 30000},
        device=device,
        disable_update=True,
    )

    for index, row in enumerate(manifest, start=1):
        started = time.time()
        wav_path = row.get("wav_path", "")
        try:
            result = model.generate(
                input=wav_path,
                cache={},
                language=args.language,
                use_itn=True,
                batch_size_s=args.batch_size_s,
                merge_vad=True,
                merge_length_s=args.merge_length_s,
                hotword=args.hotwords,
            )
            transcript = clean_text(flatten_result(result))
            append_jsonl(
                args.output,
                {
                    **row,
                    "status": "success" if transcript else "failed",
                    "transcript": transcript,
                    "elapsed_ms": round((time.time() - started) * 1000),
                    "device": device,
                    "error": "" if transcript else "empty transcript",
                },
            )
            print(
                json.dumps(
                    {
                        "event": "done",
                        "index": index,
                        "total": len(manifest),
                        "id": row.get("id"),
                        "chars": len(transcript),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as exc:
            append_jsonl(
                args.output,
                {
                    **row,
                    "status": "failed",
                    "transcript": "",
                    "elapsed_ms": round((time.time() - started) * 1000),
                    "device": device,
                    "error": str(exc),
                },
            )
            print(
                json.dumps(
                    {
                        "event": "failed",
                        "index": index,
                        "total": len(manifest),
                        "id": row.get("id"),
                        "error": str(exc),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
