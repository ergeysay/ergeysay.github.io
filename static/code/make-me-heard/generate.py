#!/usr/bin/env python3
"""
generate.py - bake an audio file into a waveform animation dataset.

Produces a JSON of {frame_index: [band_0 .. band_N]} where each value is in
[0, 1] and represents the height of a frequency band at that animation frame.

The spectral model follows Web Audio's AnalyserNode (8192-sample Blackman window,
dB magnitude, temporal smoothing) and then rebins the linear FFT bins into
1/8-octave bands. The frame count is derived from the audio, so the final note
decays into silence instead of being cut off.

Usage:
    python generate.py input.mp3 [output.json]

Requires: ffmpeg on PATH, numpy.
"""
import json
import subprocess
import sys

import numpy as np

# ---- configuration -------------------------------------------------------
SR        = 44100      # analysis sample rate
N_FFT     = 8192       # FFT window size (AnalyserNode.fftSize)
FPS       = 120.0      # animation frames per second
N_BANDS   = 70         # output bands per frame
MIN_FREQ  = 20.0       # lowest band centre (Hz)
MAX_FREQ  = 22000.0    # highest band centre (Hz)
MIN_DB    = -85.0      # maps to value 0   (AnalyserNode.minDecibels)
MAX_DB    = -25.0      # maps to value 1   (AnalyserNode.maxDecibels)
SMOOTHING = 0.5        # temporal EMA between frames (smoothingTimeConstant)
C_1       = 8.17579892 # frequency of note C-1, the octave-band anchor


# ---- 1) audio ------------------------------------------------------------
def load_audio(path):
    """Decode any ffmpeg-readable file to mono float32 PCM at SR."""
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path,
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(pcm, dtype=np.float32)


# ---- 2) frequency bands --------------------------------------------------
def octave_bands():
    """1/8-octave equal-tempered bands from C-1 upward, kept within
    [MIN_FREQ, MAX_FREQ]. Each band is the FFT bin range covering its width."""
    band_width = 2 ** (1 / 8)
    half_band  = band_width ** 0.5
    hz_per_bin = SR / N_FFT
    nyquist    = N_FFT // 2

    bands, freq = [], C_1
    while freq <= MAX_FREQ:
        if freq >= MIN_FREQ:
            lo = min(int((freq / half_band) / hz_per_bin), nyquist - 1)
            hi = min(int((freq * half_band) / hz_per_bin), nyquist - 1)
            bands.append((lo, hi))
        freq *= band_width
    return bands


# ---- 3) spectrogram ------------------------------------------------------
def analyse(y):
    """Slide an FFT window over the audio at FPS and reduce each frame to bands.

    The window ENDS at each frame's timestamp (most-recent-samples, like a live
    AnalyserNode). We run until the window has slid fully past the audio, so the
    final sound decays into the zero-padded tail instead of being cut off."""
    window = np.blackman(N_FFT)               # AnalyserNode uses a Blackman window
    bands  = octave_bands()
    hop    = SR / FPS
    n_frames = int(np.ceil((len(y) + N_FFT) / hop))

    raw = np.full((n_frames, len(bands)), MIN_DB)
    prev_mag = np.zeros(N_FFT // 2 + 1)
    for f in range(n_frames):
        end = int(round((f + 1) * hop))
        seg = y[max(0, end - N_FFT):min(end, len(y))]
        if len(seg) < N_FFT:                  # zero-pad as the window leaves the audio
            seg = np.concatenate([np.zeros(N_FFT - len(seg)), seg])

        mag = np.abs(np.fft.rfft(seg * window)) / N_FFT
        mag = SMOOTHING * prev_mag + (1 - SMOOTHING) * mag
        prev_mag = mag
        db = 20 * np.log10(mag + 1e-12)
        for i, (lo, hi) in enumerate(bands):
            raw[f, i] = db[lo:hi + 1].max()   # loudest bin in the band

    # normalise dB -> [0, 1], then resample the octave bands to N_BANDS columns
    norm = np.clip((raw - MIN_DB) / (MAX_DB - MIN_DB), 0.0, 1.0)
    src  = np.arange(len(bands))
    dst  = np.linspace(0, len(bands) - 1, N_BANDS)
    return np.stack([np.interp(dst, src, norm[f]) for f in range(n_frames)])

    # Band 0 is the lowest frequency; there's no horizontal flip here. Any
    # mirroring is a display choice for the renderer, not part of the data.


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "makemeheard.mp3"
    out = sys.argv[2] if len(sys.argv) > 2 else "data.json"

    y = load_audio(src)
    frames = analyse(y)
    data = {str(i): [round(float(v), 3) for v in frames[i]]
            for i in range(len(frames))}
    json.dump(data, open(out, "w"))
    print(f"{src}: {len(y) / SR:.2f}s -> {len(frames)} frames x {N_BANDS} bands"
          f" @ {FPS:g}fps -> {out}")


if __name__ == "__main__":
    main()
