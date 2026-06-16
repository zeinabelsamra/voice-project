from flask import Flask, request, jsonify
from faster_whisper import WhisperModel
import os
import subprocess

app = Flask(__name__)

# ── Model ────────────────────────────────────────────────────────
# medium = best balance of speed vs accuracy for medical/Arabic names
# large-v2 = most accurate but very slow on CPU
model = WhisperModel("medium", device="cpu", compute_type="int8")

# ── Initial prompt ───────────────────────────────────────────────
# Short keyword list only — NO full sentences or patient data
# Full sentences cause Whisper to hallucinate them back when silent
INITIAL_PROMPT = (
    "Blood bank. Transfusion. Delivery. Packed cells. FFP. Platelets. "
    "Hemodialysis. Thalassemia. Anemia. Hemorrhage. Sepsis. "
    "File number. Blood group. RH factor. Positive. Negative. "
    "Routine. Stat. Pre-op. Room. Ward. ICU. "
    "Technician. Orderly. Nurse. Physician. Doctor. "
    "Leakage. Gases. Temperature. Degrees. Milliliters. "
    "Next patient. Life saving."
)

# ── Exact hallucination strings ──────────────────────────────────
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching.", "thanks for watching",
    "please subscribe.", "subscribe.", "thanks.", "thanks",
    "you", ".", "", " ", "uh", "um", "hmm", ",", "...", "…",
    "subtitles by", "subtitles", "www.", ".com",
    "bye.", "bye", "goodbye.", "goodbye",
    "okay.", "okay", "ok.", "ok",
    "yes.", "yes", "no.", "no",
    "hello.", "hello", "hi.", "hi",
    "the", "the.", "an", "and", "or",
    "i", "i.", "oh", "oh.", "ah", "ah.",
    "hmm.", "hm.", "hm", "mm.", "mm",
    "so", "so.", "well", "well.",
    "right", "right.", "sure", "sure.",
    "شكراً", "شكرا", "مرحبا",
}

# ── Partial pattern hallucinations ──────────────────────────────
HALLUCINATION_PATTERNS = [
    "subtitles by", "translated by", "transcript by",
    "www.", ".com", ".net",
    "copyright", "all rights reserved",
    "♪", "♫",
]


def is_hallucination(text):
    """Return True if segment looks like a Whisper hallucination."""
    stripped = text.strip()
    cleaned  = stripped.lower().rstrip('.').rstrip(',')

    if cleaned in HALLUCINATIONS or stripped in HALLUCINATIONS:
        return True

    for pattern in HALLUCINATION_PATTERNS:
        if pattern in cleaned:
            return True

    # Single-word segments are almost always hallucinations
    # (2+ word segments are allowed — short phrases like "A positive", "unit 1234567" are valid)
    if len(stripped.split()) < 2:
        return True

    return False


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio     = request.files["audio"]
    webm_path = "temp_input.webm"
    wav_path  = "temp_output.wav"
    audio.save(webm_path)

    file_size = os.path.getsize(webm_path)
    print(f"Received audio: {file_size} bytes")

    # ── Reject silent/too-short recordings ──────────────────────────
    # 4 KB covers ~0.25s at highest webm quality — genuine silence is < 3 KB
    if file_size < 4000:
        return jsonify({"text": "No speech detected", "language": "en", "word_count": 0})

    # ── Convert to WAV ───────────────────────────────────────────────
    # volume=3.0        — moderate amp (8.0 caused distortion)
    # highpass=f=200    — cut low rumble and desk thumps
    # lowpass=f=6000    — cut high hiss
    # afftdn=nf=-20     — AI noise reduction
    # acompressor       — normalize quiet/loud words equally
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-i", webm_path,
            "-ar", "16000",
            "-ac", "1",
            "-acodec", "pcm_s16le",
            "-af", (
                "volume=3.0,"
                "highpass=f=200,"
                "lowpass=f=6000,"
                "afftdn=nf=-20,"
                "acompressor=threshold=-20dB:ratio=4:attack=5:release=50"
            ),
            wav_path
        ], check=True, capture_output=True)
        print("ffmpeg OK")
    except subprocess.CalledProcessError as e:
        print("ffmpeg error:", e.stderr.decode())
        return jsonify({"error": "ffmpeg failed", "details": e.stderr.decode()}), 500
    except FileNotFoundError:
        return jsonify({"error": "ffmpeg not installed"}), 500

    wav_size = os.path.getsize(wav_path)
    print(f"WAV size: {wav_size} bytes")

    # ── Reject if WAV too small = silence ────────────────────────────
    if wav_size < 32000:
        for path in [webm_path, wav_path]:
            if os.path.exists(path): os.remove(path)
        return jsonify({"text": "No speech detected", "language": "en", "word_count": 0})

    # ── Transcribe ───────────────────────────────────────────────────
    segments, info = model.transcribe(
        wav_path,
        language="en",
        beam_size=5,
        best_of=5,
        temperature=[0.0, 0.2],
        condition_on_previous_text=False,
        no_speech_threshold=0.8,
        initial_prompt=INITIAL_PROMPT,
        vad_filter=False,
    )

    segment_list = list(segments)
    print(f"Segments: {len(segment_list)}")

    valid_segments = []
    for s in segment_list:
        print(f"  [{s.start:.2f}s→{s.end:.2f}s] '{s.text}' | no_speech={s.no_speech_prob:.2f}")

        # Reject silence
        if s.no_speech_prob > 0.80:
            print(f"  ⚠️ Rejected (no_speech_prob={s.no_speech_prob:.2f})")
            continue

        # Reject hallucinations
        if is_hallucination(s.text):
            print(f"  ⚠️ Rejected (hallucination): '{s.text.strip()}'")
            continue

        # Reject very short duration segments
        duration = s.end - s.start
        if duration < 0.5:
            print(f"  ⚠️ Rejected (too short: {duration:.2f}s)")
            continue

        valid_segments.append(s.text.strip())

    text = " ".join(valid_segments).strip()
    print(f"Final transcript: '{text}'")

    for path in [webm_path, wav_path]:
        if os.path.exists(path):
            os.remove(path)

    return jsonify({
        "text":       text if text else "No speech detected",
        "language":   info.language,
        "word_count": len(text.split()) if text else 0
    })


if __name__ == "__main__":
    print("✅ Whisper service running on port 5001")
    app.run(port=5001, debug=False, use_reloader=False)