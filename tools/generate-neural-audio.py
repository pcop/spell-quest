#!/usr/bin/env python3
"""
generate-neural-audio.py

使用微軟 Edge-TTS (en-US-JennyNeural) 產生高品質神經網路真人發音音檔：
1. words-audio/: 包含 data.json 內所有單字的高音質朗讀音檔。
2. phonics-audio/: 包含 53 個自然拼讀音素 (Phonics Chunks) 的清晰真人發音音檔。

需要：python3, pip install edge-tts, ffmpeg
執行：python3 tools/generate-neural-audio.py
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import edge_tts

VOICE = "en-US-JennyNeural"
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS_DIR = os.path.join(ROOT_DIR, "words-audio")
PHONICS_DIR = os.path.join(ROOT_DIR, "phonics-audio")
DATA_FILE = os.path.join(ROOT_DIR, "data.json")

# 53 個 Phonics 音素的自然發音來源設定
CHUNK_CONFIG = {
    # 單字母短母音（以標準自然發音教學代表詞生成短母音）
    "a": {"word": "at", "start": 0.0, "end": 0.35},
    "e": {"word": "ed", "start": 0.0, "end": 0.32},
    "i": {"word": "it", "start": 0.0, "end": 0.30},
    "o": {"word": "ox", "start": 0.0, "end": 0.35},
    "u": {"word": "up", "start": 0.0, "end": 0.30},
    "y": {"word": "happy", "start": 0.30, "end": 0.65},  # /i/

    # 母音組合
    "ee": {"word": "see", "start": 0.10, "end": 0.50},
    "ea": {"word": "eat", "start": 0.0, "end": 0.40},
    "oo": {"word": "moon", "start": 0.10, "end": 0.50},
    "ow": {"word": "cow", "start": 0.10, "end": 0.55},
    "ou": {"word": "out", "start": 0.0, "end": 0.42},
    "ay": {"word": "say", "start": 0.10, "end": 0.50},
    "ue": {"word": "blue", "start": 0.15, "end": 0.55},
    "eigh": {"word": "eight", "start": 0.0, "end": 0.40},
    "oa": {"word": "oak", "start": 0.0, "end": 0.40},
    "aw": {"word": "saw", "start": 0.10, "end": 0.50},

    # R-controlled 母音
    "ar": {"word": "art", "start": 0.0, "end": 0.45},
    "er": {"word": "her", "start": 0.10, "end": 0.50},
    "ir": {"word": "bird", "start": 0.10, "end": 0.50},
    "or": {"word": "for", "start": 0.10, "end": 0.50},
    "ur": {"word": "fur", "start": 0.10, "end": 0.50},
    "air": {"word": "air", "start": 0.0, "end": 0.45},
    "ear": {"word": "ear", "start": 0.0, "end": 0.45},
    "our": {"word": "four", "start": 0.10, "end": 0.50},
    "oor": {"word": "door", "start": 0.10, "end": 0.50},

    # 單子音
    "b": {"word": "bat", "start": 0.0, "end": 0.22},
    "c": {"word": "cat", "start": 0.0, "end": 0.22},
    "d": {"word": "dog", "start": 0.0, "end": 0.22},
    "f": {"word": "fox", "start": 0.0, "end": 0.30},
    "g": {"word": "go", "start": 0.0, "end": 0.25},
    "h": {"word": "hat", "start": 0.0, "end": 0.25},
    "k": {"word": "kite", "start": 0.0, "end": 0.22},
    "l": {"word": "leg", "start": 0.0, "end": 0.30},
    "m": {"word": "man", "start": 0.0, "end": 0.35},
    "n": {"word": "net", "start": 0.0, "end": 0.35},
    "p": {"word": "pen", "start": 0.0, "end": 0.22},
    "r": {"word": "red", "start": 0.0, "end": 0.30},
    "s": {"word": "sun", "start": 0.0, "end": 0.35},
    "t": {"word": "ten", "start": 0.0, "end": 0.22},
    "v": {"word": "van", "start": 0.0, "end": 0.35},
    "w": {"word": "win", "start": 0.0, "end": 0.28},
    "x": {"word": "box", "start": 0.28, "end": 0.65},
    "z": {"word": "zoo", "start": 0.0, "end": 0.35},

    # 雙字母子音 & 疊字
    "ch": {"word": "chair", "start": 0.0, "end": 0.30},
    "sh": {"word": "sheep", "start": 0.0, "end": 0.35},
    "th": {"word": "think", "start": 0.0, "end": 0.30},
    "ck": {"word": "duck", "start": 0.25, "end": 0.55},
    "wh": {"word": "white", "start": 0.0, "end": 0.30},
    "nk": {"word": "pink", "start": 0.25, "end": 0.60},
    "ll": {"word": "ball", "start": 0.25, "end": 0.60},
    "rr": {"word": "red", "start": 0.0, "end": 0.30},
    "pp": {"word": "pen", "start": 0.0, "end": 0.22},
    "eye": {"word": "eye", "start": 0.0, "end": 0.50},
}


async def generate_tts(text: str, out_path: str, rate: str = "-5%"):
    """使用 Edge-TTS 產生原始語音"""
    comm = edge_tts.Communicate(text, VOICE, rate=rate)
    await comm.save(out_path)


def process_audio(raw_mp3: str, out_mp3: str, start: float = 0.0, end: float = None):
    """使用 ffmpeg 進行精確修剪、靜音消除與淡出淡入處理"""
    filters = [
        "silenceremove=start_periods=1:start_duration=0.01:start_threshold=-50dB"
    ]
    if start > 0:
        filters.append(f"atrim=start={start}")
    if end is not None:
        filters.append(f"atrim=end={end}")
    filters.append("silenceremove=stop_periods=1:stop_duration=0.03:stop_threshold=-45dB")
    
    # 微量淡出避免切斷音爆聲 (click sound)
    filters.append("afade=t=in:st=0:d=0.01")
    filters.append("afade=t=out:st=0.2:d=0.04")

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", raw_mp3,
        "-af", ",".join(filters),
        "-codec:a", "libmp3lame", "-qscale:a", "2",
        out_mp3
    ]
    subprocess.run(cmd, check=True)


def process_word_audio(raw_mp3: str, out_mp3: str):
    """單字語音前後去除靜音並標準化音量"""
    filters = [
        "silenceremove=start_periods=1:start_duration=0.01:start_threshold=-50dB",
        "silenceremove=stop_periods=1:stop_duration=0.05:stop_threshold=-50dB",
        "loudnorm=I=-16:TP=-1.5:LRA=11"
    ]
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", raw_mp3,
        "-af", ",".join(filters),
        "-codec:a", "libmp3lame", "-qscale:a", "2",
        out_mp3
    ]
    subprocess.run(cmd, check=True)


async def main():
    os.makedirs(WORDS_DIR, exist_ok=True)
    os.makedirs(PHONICS_DIR, exist_ok=True)

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 1. 產生所有單字音檔
    words = sorted(list(set(entry["word"].strip().lower() for entry in data["wordBank"])))
    print(f"🎙️ 開始產生 {len(words)} 個單字音檔 (words-audio/)...")

    with tempfile.TemporaryDirectory() as tmpdir:
        for idx, word in enumerate(words, 1):
            raw_tmp = os.path.join(tmpdir, f"word_{word}_raw.mp3")
            out_file = os.path.join(WORDS_DIR, f"{word}.mp3")
            try:
                await generate_tts(word, raw_tmp, rate="-5%")
                process_word_audio(raw_tmp, out_file)
                print(f"  [{idx}/{len(words)}] ✅ {word}.mp3")
            except Exception as e:
                print(f"  [{idx}/{len(words)}] ❌ {word}.mp3 錯誤: {e}")

    # 2. 產生 53 個 Phonics 音素音檔
    print(f"\n🎧 開始產生 {len(CHUNK_CONFIG)} 個自然拼讀音素 (phonics-audio/)...")
    with tempfile.TemporaryDirectory() as tmpdir:
        for idx, (chunk, cfg) in enumerate(CHUNK_CONFIG.items(), 1):
            raw_tmp = os.path.join(tmpdir, f"chunk_{chunk}_raw.mp3")
            out_file = os.path.join(PHONICS_DIR, f"{chunk}.mp3")
            try:
                await generate_tts(cfg["word"], raw_tmp, rate="-5%")
                process_audio(raw_tmp, out_file, start=cfg["start"], end=cfg["end"])
                print(f"  [{idx}/{len(CHUNK_CONFIG)}] ✅ {chunk}.mp3 (源自: {cfg['word']})")
            except Exception as e:
                print(f"  [{idx}/{len(CHUNK_CONFIG)}] ❌ {chunk}.mp3 錯誤: {e}")

    print("\n🎉 全部神經網路真人音檔生成完成！")


if __name__ == "__main__":
    asyncio.run(main())
