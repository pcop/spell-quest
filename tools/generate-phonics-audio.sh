#!/usr/bin/env bash
# 產生 phonics-audio/ 底下所有自然發音音素的 mp3 音檔。
#
# 為什麼不用「假拼字」餵給瀏覽器 TTS：瀏覽器的 SpeechSynthesis 只吃純文字，
# 沒辦法直接指定音素，只能賭一個拼字會被唸對——這正是這支腳本要解決的問題
# （例如舊做法把 th 拼成 "thh"，被部分瀏覽器語音引擎當成縮寫逐字母唸成 "t h"）。
# espeak-ng 支援用 [[...]] 語法直接指定音素代碼（不是猜字），所以離線生成一次、
# 全部瀏覽器聽起來都一樣、不再受個別瀏覽器/語音引擎的猜測影響。
#
# 用法：在專案根目錄執行 `bash tools/generate-phonics-audio.sh`
# 需要：espeak-ng、ffmpeg（兩者都是免費、開源、無授權疑慮）
#
# 新增單字如果用到下面表格沒有的新 chunk 組合，在 CHUNKS 陣列裡新增一行、
# 重新執行這支腳本即可——不用手動錄音或找音檔素材。
# 音素代碼是用 `espeak-ng -x -v en-us "<真實英文單字>"` 反查真實單字的發音、
# 取出目標音素對應的代碼片段（例如 "think" -> T'INk，開頭的 T 就是 th 的清音）。
# 代碼前面的單引號 ' 是重音記號，一定要保留，不然像 I（短 i）會被解析成
# 錯誤的長音 i（詳見這次生成時的踩坑紀錄，直接省略引號會讓短母音變長母音）。

set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="phonics-audio"
mkdir -p "$OUT_DIR"

# -s 150：espeak-ng 預設語速是 175（正常語速），單一音素用 130 測試時每段
# 尾端會拖一截安靜的 padding（例如 th 量到 0.65 秒，明顯比實際發音時間長），
# 7 段式的單字（例如 banana）串起來會感覺拖沓。150 是折衷值：比預設稍慢、
# 保留兒童學習需要的清晰速度，同時縮短無意義的靜音尾巴。曾經試過用
# ffmpeg 的 silenceremove 濾鏡直接裁掉靜音，量到能壓到 0.04 秒，但沒辦法用
# 耳朵確認裁切邊界會不會連子音本身的擦音都一起削掉，風險太高沒有採用；
# 如果實測後還是覺得段落間拖沓，可以再調高這個數字或重新考慮裁切方案。
declare -A CHUNKS=(
  # 單一字母：子音用子音音，母音用短母音音（符合自然發音教學慣例）
  [a]="'a"    [b]="b"    [c]="k"    [d]="d"    [e]="'E"   [f]="f"
  [g]="g"     [h]="h"    [i]="'I"   [k]="k"    [l]="l"    [m]="m"
  [n]="n"     [o]="'0"   [p]="p"    [r]="r"    [s]="s"    [t]="t"
  [u]="'V"    [v]="v"    [w]="w"    [x]="ks"   [y]="'i"   [z]="z"
  # 子音群（雙字母）
  [ch]="tS"   [sh]="S"   [th]="T"   [ck]="k"   [wh]="w"   [nk]="Nk"
  # 母音團
  [ee]="'i:"  [ea]="'i:" [oo]="'u:" [ow]="'aU" [ou]="'aU" [ay]="'eI"
  [ue]="'u:"  [eigh]="'eI" [oa]="'oU" [aw]="'O:"
  # R controlled 母音
  [ar]="'A@"  [er]="'3:" [ir]="'3:" [or]="'O@" [ur]="'3:"
  [air]="'e@" [ear]="'i@3" [our]="'o@" [oor]="'o@"
  # 疊字子音，跟單字母同音
  [ll]="l"    [rr]="r"   [pp]="p"
)

# eye 這個 chunk 本身就是一個完整的英文單字（不規則拼法，sight word），
# 直接唸這個字就是正確發音，不需要走音素拼湊；跟上面用 [[...]] 音素代碼
# 指定發音的其他 50 個 chunk 不同，用純文字直接餵給 espeak-ng。
LITERAL_WORD_CHUNKS=(eye)

count=0
for chunk in "${!CHUNKS[@]}"; do
  code="${CHUNKS[$chunk]}"
  tmp_wav="$(mktemp --suffix=.wav)"
  espeak-ng -v en-us -s 150 -w "$tmp_wav" "[[$code]]"
  ffmpeg -y -loglevel error -i "$tmp_wav" -codec:a libmp3lame -qscale:a 4 "$OUT_DIR/$chunk.mp3"
  rm -f "$tmp_wav"
  count=$((count + 1))
done

for chunk in "${LITERAL_WORD_CHUNKS[@]}"; do
  tmp_wav="$(mktemp --suffix=.wav)"
  espeak-ng -v en-us -s 150 -w "$tmp_wav" "$chunk"
  ffmpeg -y -loglevel error -i "$tmp_wav" -codec:a libmp3lame -qscale:a 4 "$OUT_DIR/$chunk.mp3"
  rm -f "$tmp_wav"
  count=$((count + 1))
done

echo "已產生 $count 個音檔到 $OUT_DIR/"
