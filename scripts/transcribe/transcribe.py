#!/usr/bin/env python3
"""
Расшифровка записи звонка на этом сервере (call_transcribe): faster-whisper, запись никуда не отправляется.

Запуск: python transcribe.py <файл> [--model small] [--language ru] [--hotwords "слово, слово"] [--stereo auto|split|mono]
Результат — JSON в stdout: {"duration": сек, "channels": 1|2, "segments": [{"start", "end", "speaker", "text"}]}.

Разделение «менеджер / клиент»: многие АТС пишут разговор в стерео, каждая сторона в своём канале. Если каналы
заметно различаются, каждый расшифровывается отдельно (speaker 1 — левый, 2 — правый) и реплики сливаются по времени.
Моно-запись — одним текстом (speaker null).
"""
import argparse
import inspect
import json
import sys

SAMPLE_RATE = 16000


def channels_differ(left, right):
    import numpy as np

    level = float(np.abs(left).mean() + np.abs(right).mean()) / 2
    if level < 1e-6:
        return False
    return float(np.abs(left - right).mean()) / level > 0.1


def transcribe(model, audio, options):
    segments, _info = model.transcribe(audio, **options)
    return [
        {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
        for s in segments
        if s.text.strip()
    ]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("--model", default="small")
    p.add_argument("--language", default="ru")
    p.add_argument("--hotwords", default="")
    p.add_argument("--stereo", choices=["auto", "split", "mono"], default="auto")
    p.add_argument("--device", default="cpu")
    p.add_argument("--compute-type", default="int8")
    a = p.parse_args()

    from faster_whisper import WhisperModel, decode_audio

    model = WhisperModel(a.model, device=a.device, compute_type=a.compute_type)
    options = {"language": a.language, "vad_filter": True, "beam_size": 5}
    if a.hotwords:
        # initial_prompt понимают все версии; hotwords — с faster-whisper 1.0.
        options["initial_prompt"] = "Термины: " + a.hotwords + "."
        if "hotwords" in inspect.signature(model.transcribe).parameters:
            options["hotwords"] = a.hotwords

    mono = decode_audio(a.audio, sampling_rate=SAMPLE_RATE)
    duration = round(len(mono) / SAMPLE_RATE, 2)
    stereo = None
    if a.stereo != "mono":
        try:
            left, right = decode_audio(a.audio, sampling_rate=SAMPLE_RATE, split_stereo=True)
            if a.stereo == "split" or channels_differ(left, right):
                stereo = (left, right)
        except Exception:  # noqa: BLE001 — моно-файл или декодер без split_stereo
            stereo = None

    if stereo:
        segments = []
        for speaker, audio in ((1, stereo[0]), (2, stereo[1])):
            segments += [dict(s, speaker=speaker) for s in transcribe(model, audio, options)]
        segments.sort(key=lambda s: (s["start"], s["speaker"]))
        channels = 2
    else:
        segments = [dict(s, speaker=None) for s in transcribe(model, mono, options)]
        channels = 1

    json.dump({"duration": duration, "channels": channels, "segments": segments}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
