#include "mss/mss.h"
#include <Utility/gx_trace.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <emscripten.h>

extern "C" char* WebAudioBridge_ReadEntireFile(const char* filename, uint32_t* out_size);
// where a file lies inside a mounted .big: the archive's URL (server or blob:), offset and size
extern "C" bool WebAudioBridge_LocateFile(const char* filename, const char** url, uint32_t* offset, uint32_t* size);

// IMA ADPCM tables
static const int indexTable[16] = {
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
};

static const int stepTable[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
};

struct WavHeader {
    char riff[4];          // "RIFF"
    uint32_t riff_size;    // size of file - 8
    char wave[4];          // "WAVE"
    char fmt[4];           // "fmt "
    uint32_t fmt_size;     // 16
    uint16_t format_tag;   // 1 (PCM)
    uint16_t channels;     // channels
    uint32_t sample_rate;  // rate
    uint32_t byte_rate;    // rate * channels * 2
    uint16_t block_align;  // channels * 2
    uint16_t bits;         // 16
    char data[4];          // "data"
    uint32_t data_size;    // PCM data size
};

struct WavHeaderInfo {
    int format;
    int channels;
    int sample_rate;
    int bits_per_sample;
    const uint8_t* data_ptr;
    uint32_t data_len;
    uint32_t block_align;
};

static bool parse_wav(const void* file_image, WavHeaderInfo& info) {
    if (!file_image) return false;
    const uint8_t* buf = (const uint8_t*)file_image;
    if (memcmp(buf, "RIFF", 4) != 0) return false;
    uint32_t riff_size = *(const uint32_t*)(buf + 4);
    if (memcmp(buf + 8, "WAVE", 4) != 0) return false;

    const uint8_t* p = buf + 12;
    const uint8_t* end = buf + 8 + riff_size;
    info.data_ptr = nullptr;
    info.data_len = 0;
    info.block_align = 0;

    while (p + 8 <= end) {
        char chunk_id[4];
        memcpy(chunk_id, p, 4);
        uint32_t chunk_size = *(const uint32_t*)(p + 4);
        p += 8;

        if (memcmp(chunk_id, "fmt ", 4) == 0) {
            if (chunk_size >= 16) {
                info.format = *(const uint16_t*)p;
                info.channels = *(const uint16_t*)(p + 2);
                info.sample_rate = *(const uint32_t*)(p + 4);
                info.bits_per_sample = *(const uint16_t*)(p + 14);
                if (chunk_size >= 32) {
                    info.block_align = *(const uint16_t*)(p + 32);
                } else if (chunk_size >= 20) {
                    info.block_align = *(const uint16_t*)(p + 12);
                }
            }
        } else if (memcmp(chunk_id, "data", 4) == 0) {
            info.data_ptr = p;
            info.data_len = chunk_size;
        }
        p += chunk_size;
        if (chunk_size & 1) p++;
    }
    return info.data_ptr != nullptr;
}

static void decode_block_mono(const uint8_t* src, uint32_t block_size, int16_t* dst) {
    int16_t pred = *(const int16_t*)src;
    int8_t idx = src[2];
    src += 4;

    *dst++ = pred;

    const uint8_t* block_end = src - 4 + block_size;
    while (src < block_end) {
        uint8_t val = *src++;
        // Low nibble
        uint8_t nibble = val & 0x0F;
        int step = stepTable[idx];
        int diff = step >> 3;
        if (nibble & 4) diff += step;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 1) diff += step >> 2;
        if (nibble & 8) pred -= diff; else pred += diff;
        if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
        idx += indexTable[nibble];
        if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
        *dst++ = pred;

        // High nibble
        nibble = (val >> 4) & 0x0F;
        step = stepTable[idx];
        diff = step >> 3;
        if (nibble & 4) diff += step;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 1) diff += step >> 2;
        if (nibble & 8) pred -= diff; else pred += diff;
        if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
        idx += indexTable[nibble];
        if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
        *dst++ = pred;
    }
}

static void decode_block_stereo(const uint8_t* src, uint32_t block_size, int16_t* dst_interleaved) {
    int16_t pred_l = *(const int16_t*)src;
    int8_t idx_l = src[2];
    int16_t pred_r = *(const int16_t*)(src + 4);
    int8_t idx_r = src[6];
    src += 8;

    int16_t samples_l[4096];
    int16_t samples_r[4096];
    int out_l = 0;
    int out_r = 0;

    samples_l[out_l++] = pred_l;
    samples_r[out_r++] = pred_r;

    const uint8_t* block_end = src - 8 + block_size;
    while (src < block_end) {
        for (int i = 0; i < 8 && src < block_end; i++) {
            uint8_t val = *src++;
            uint8_t nibble = val & 0x0F;
            int step = stepTable[idx_l];
            int diff = step >> 3;
            if (nibble & 4) diff += step;
            if (nibble & 2) diff += step >> 1;
            if (nibble & 1) diff += step >> 2;
            if (nibble & 8) pred_l -= diff; else pred_l += diff;
            if (pred_l > 32767) pred_l = 32767; else if (pred_l < -32768) pred_l = -32768;
            idx_l += indexTable[nibble];
            if (idx_l < 0) idx_l = 0; else if (idx_l > 88) idx_l = 88;
            samples_l[out_l++] = pred_l;

            nibble = (val >> 4) & 0x0F;
            step = stepTable[idx_l];
            diff = step >> 3;
            if (nibble & 4) diff += step;
            if (nibble & 2) diff += step >> 1;
            if (nibble & 1) diff += step >> 2;
            if (nibble & 8) pred_l -= diff; else pred_l += diff;
            if (pred_l > 32767) pred_l = 32767; else if (pred_l < -32768) pred_l = -32768;
            idx_l += indexTable[nibble];
            if (idx_l < 0) idx_l = 0; else if (idx_l > 88) idx_l = 88;
            samples_l[out_l++] = pred_l;
        }
        for (int i = 0; i < 8 && src < block_end; i++) {
            uint8_t val = *src++;
            uint8_t nibble = val & 0x0F;
            int step = stepTable[idx_r];
            int diff = step >> 3;
            if (nibble & 4) diff += step;
            if (nibble & 2) diff += step >> 1;
            if (nibble & 1) diff += step >> 2;
            if (nibble & 8) pred_r -= diff; else pred_r += diff;
            if (pred_r > 32767) pred_r = 32767; else if (pred_r < -32768) pred_r = -32768;
            idx_r += indexTable[nibble];
            if (idx_r < 0) idx_r = 0; else if (idx_r > 88) idx_r = 88;
            samples_r[out_r++] = pred_r;

            nibble = (val >> 4) & 0x0F;
            step = stepTable[idx_r];
            diff = step >> 3;
            if (nibble & 4) diff += step;
            if (nibble & 2) diff += step >> 1;
            if (nibble & 1) diff += step >> 2;
            if (nibble & 8) pred_r -= diff; else pred_r += diff;
            if (pred_r > 32767) pred_r = 32767; else if (pred_r < -32768) pred_r = -32768;
            idx_r += indexTable[nibble];
            if (idx_r < 0) idx_r = 0; else if (idx_r > 88) idx_r = 88;
            samples_r[out_r++] = pred_r;
        }
    }

    for (int i = 0; i < out_l && i < out_r; i++) {
        *dst_interleaved++ = samples_l[i];
        *dst_interleaved++ = samples_r[i];
    }
}


// ============================================================================================
// GeneralsX @feature WebPort 2026-10-30 — the Web Audio side of the Miles API.
//
// One JS object, window.AILBridge, owns the AudioContext and a voice per handle, keyed by the
// handle's JS id: 2D samples 1..128, 3D samples 501..628, streams 1001..1032. Every voice ends in
// a gain node on one master bus (master gain -> analyser -> destination).
//
// End of playback is reported back through AIL_trigger_sample_eos(jsId): MilesAudioManager only
// learns a sound finished from the EOS callbacks, so every started voice must end in exactly one
// EOS — also one that never decoded (decode error, missing data), or its channel would never be
// freed. Stopping a voice (AIL_stop_*, AIL_end_*, release, a new file) bumps its generation and
// suppresses the EOS of what was playing, as Miles does.
//
// Samples: WAV images the engine already holds in memory (AudioFileCache). Decoded AudioBuffers
// are cached by content (size + sampled bytes), so a sound decodes once, not on every play.
// Streams (music, speech): the bytes are fetched asynchronously — straight from the archive with
// a Range request when the file is inside a mounted .big (BigVFS, server or blob: URL), else read
// once from the engine's file system — and played by an <audio> element through the same bus.
//
// window.GX_audioStats() (bracket-named, survives Closure) reports counters and the output level
// for the CI audio test; ?diag=1 adds "AUDIO:" console lines for streams and failures.
// ============================================================================================
EM_JS(void, AILBridge_init, (), {
  if (window['AILBridge']) return;
  var diag = /[?&]diag=1/.test(location.search);
  var verbose = !!window['gxAudioVerbose'];
  var B = {
    ctx: null, master: null, analyser: null,
    voices: {},
    cache: new Map(), cacheBytes: 0,
    stats: { started2D: 0, started3D: 0, streamsStarted: 0, streamsReady: 0, eos: 0, eos3D: 0, eosStream: 0, decoded: 0, cacheHits: 0,
             decodeErrors: 0, streamErrors: 0, notReady: 0, maxRms: 0 },

    init: function () {
      if (B.ctx) return;
      var AC = window['AudioContext'] || window['webkitAudioContext'];
      if (!AC) { console.warn('[AILBridge] no Web Audio'); return; }
      B.ctx = new AC();
      B.master = B.ctx.createGain();
      B.analyser = B.ctx.createAnalyser();
      B.analyser.fftSize = 2048;
      B.master.connect(B.analyser);
      B.analyser.connect(B.ctx.destination);
      B['audioContext'] = B.ctx;                     // web_shell.html resumes it on the first gesture
      if (window['Module']) {
        if (!window['Module']['SDL2']) window['Module']['SDL2'] = {};
        window['Module']['SDL2']['audioContext'] = B.ctx;
      }
      if (diag) {
        var buf = new Float32Array(B.analyser.fftSize);
        setInterval(function () {
          B.analyser.getFloatTimeDomainData(buf);
          var sum = 0;
          for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          var rms = Math.sqrt(sum / buf.length);
          if (rms > B.stats.maxRms) B.stats.maxRms = rms;
        }, 100);
        console.log('AUDIO: context ' + B.ctx.state + ' ' + B.ctx.sampleRate + ' Hz');
      }
    },

    voice: function (id) {
      var v = B.voices[id];
      if (!v) {
        v = B.voices[id] = { id: id, gen: 0, file: 0, node: null, state: 'empty', buffer: null, playWhenReady: false, loops: 1, left: 1,
                             volume: 1, pan: 0.5, rate: 1, x: 0, y: 0, z: 0, minDist: 10, maxDist: 1000,
                             source: null, gain: null, panner: null, is3d: id >= 500 && id < 1000,
                             audio: null, url: null, duration: 0, name: '' };
      }
      return v;
    },

    eos: function (v, gen) {
      if (v.gen !== gen) return;                     // stopped or replaced meanwhile
      v.gen++;
      B.stats.eos++;
      if (v.id >= 1000) B.stats.eosStream++; else if (v.is3d) B.stats.eos3D++;
      Module['_AIL_trigger_sample_eos'](v.id);
    },
    eosLater: function (v) { var g = v.gen; setTimeout(function () { B.eos(v, g); }, 0); },

    // ---- samples -----------------------------------------------------------------------
    stopSource: function (v) {
      if (v.source) { var s = v.source; v.source = null; s.onended = null; try { s.stop(); } catch (e) {} }
    },
    stop: function (id) {
      var v = B.voices[id];
      if (!v) return;
      v.gen++;
      v.playWhenReady = false;
      B.stopSource(v);
      if (v.audio) { try { v.audio.pause(); } catch (e) {} }
    },
    contentKey: function (ptr, size) {
      var h = size >>> 0, step = Math.max(1, Math.floor(size / 256));
      for (var i = 0; i < size; i += step) h = (Math.imul(h, 31) + HEAPU8[ptr + i]) >>> 0;
      return size + ':' + h;
    },
    setSampleFile: function (id, ptr, size) {
      var v = B.voice(id);
      B.stop(id);
      var file = ++v.file;                           // a newer file makes this decode stale
      v.state = 'empty'; v.buffer = null;
      if (!ptr || !size || !B.ctx) { v.state = 'error'; return; }
      var key = B.contentKey(ptr, size);
      var hit = B.cache.get(key);
      if (hit) { B.cache.delete(key); B.cache.set(key, hit); v.buffer = hit; v.state = 'ready'; B.stats.cacheHits++; return; }
      // a WAV header wrapping an MP3 / Ogg payload (some mods): decode the payload itself
      var start = 0;
      if (size > 48) {
        var a = HEAPU8[ptr + 44], b = HEAPU8[ptr + 45], c = HEAPU8[ptr + 46], d = HEAPU8[ptr + 47];
        if ((a === 0x49 && b === 0x44 && c === 0x33) || (a === 0xFF && (b & 0xE0) === 0xE0) ||
            (a === 0x4F && b === 0x67 && c === 0x67 && d === 0x53)) start = 44;
      }
      var bytes = HEAPU8.slice(ptr + start, ptr + size);
      v.state = 'decoding';
      B.ctx.decodeAudioData(bytes.buffer).then(function (buffer) {
        B.stats.decoded++;
        B.cache.set(key, buffer);
        B.cacheBytes += buffer.length * buffer.numberOfChannels * 4;
        while (B.cacheBytes > 96 * 1024 * 1024 && B.cache.size > 1) {
          var oldKey = B.cache.keys().next().value, old = B.cache.get(oldKey);
          B.cache.delete(oldKey);
          B.cacheBytes -= old.length * old.numberOfChannels * 4;
        }
        if (v.file !== file) return;
        v.buffer = buffer; v.state = 'ready';
        if (v.playWhenReady) { v.playWhenReady = false; B.startSample(v); }
      }, function (err) {
        B.stats.decodeErrors++;
        if (diag) console.warn('AUDIO: decode failed for voice ' + id + ' (' + size + ' bytes): ' + err);
        if (v.file !== file) return;
        v.state = 'error';
        if (v.playWhenReady) { v.playWhenReady = false; B.eosLater(v); }
      });
    },
    setLoops: function (id, count) { var v = B.voice(id); v.loops = count; },
    play: function (id) {
      var v = B.voice(id);
      if (id >= 1000) return B.playStream(v);
      if (v.is3d) B.stats.started3D++; else B.stats.started2D++;
      B.stopSource(v);
      v.gen++;
      v.left = v.loops;
      if (v.state === 'decoding') { v.playWhenReady = true; return; }
      if (v.state !== 'ready' || !B.ctx) { B.stats.notReady++; B.eosLater(v); return; }
      B.startSample(v);
    },
    startSample: function (v) {
      var ctx = B.ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var src = ctx.createBufferSource();
      src.buffer = v.buffer;
      src.loop = v.loops === 0;
      src.playbackRate.value = v.rate;
      if (!v.gain) {
        v.gain = ctx.createGain();
        if (v.is3d) {
          v.panner = ctx.createPanner();
          v.panner.panningModel = 'equalpower';
          v.panner.distanceModel = 'inverse';
          v.panner.rolloffFactor = 1;
        } else {
          v.panner = ctx.createStereoPanner();
        }
        v.panner.connect(v.gain);
        v.gain.connect(B.master);
      }
      v.gain.gain.value = v.volume;
      B.applyPlace(v);
      src.connect(v.panner);
      var gen = v.gen;
      src.onended = function () {
        if (v.source !== src || v.gen !== gen) return;
        v.source = null;
        if (v.left > 1) { v.left--; B.startSample(v); return; }
        B.eos(v, gen);
      };
      v.source = src;
      src.start(0);
    },
    applyPlace: function (v) {
      if (!v.panner) return;
      if (v.is3d) {
        v.panner.refDistance = Math.max(0.01, v.minDist);
        v.panner.maxDistance = Math.max(v.panner.refDistance, v.maxDist);
        if (v.panner.positionX) { v.panner.positionX.value = v.x; v.panner.positionY.value = v.y; v.panner.positionZ.value = v.z; }
        else v.panner.setPosition(v.x, v.y, v.z);
      } else {
        v.panner.pan.value = Math.max(-1, Math.min(1, (v.pan - 0.5) * 2));
      }
    },
    setVolumePan: function (id, volume, pan) {
      var v = B.voice(id);
      v.volume = volume; if (pan >= 0) v.pan = pan;
      if (v.gain) v.gain.gain.value = volume;
      if (id >= 1000 && v.audio) v.audio.volume = 1;   // the gain node does the work
      B.applyPlace(v);
    },
    setRate: function (id, rate) {
      var v = B.voice(id);
      v.rate = rate > 0 ? rate : 1;
      if (v.source) v.source.playbackRate.value = v.rate;
      if (v.audio) { try { v.audio.playbackRate = v.rate; } catch (e) {} }
    },
    setPosition: function (id, x, y, z) { var v = B.voice(id); v.x = x; v.y = y; v.z = z; B.applyPlace(v); },
    setDistances: function (id, maxDist, minDist) { var v = B.voice(id); v.maxDist = maxDist; v.minDist = minDist; B.applyPlace(v); },
    setListener: function (x, y, z, fx, fy, fz, ux, uy, uz, which) {
      if (!B.ctx) return;
      var l = B.ctx.listener;
      if (which === 0) {
        if (l.positionX) { l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z; } else l.setPosition(x, y, z);
      } else if (l.forwardX) {
        l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz; l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
      } else {
        l.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    },

    // ---- streams -----------------------------------------------------------------------
    resetStream: function (v) {
      B.stop(v.id);
      if (v.audio) { try { v.audio.removeAttribute('src'); v.audio.load(); } catch (e) {} v.audio = null; }
      if (v.node) { try { v.node.disconnect(); } catch (e) {} v.node = null; }
      if (v.url) { URL.revokeObjectURL(v.url); v.url = null; }
      v.state = 'empty'; v.duration = 0; v.playWhenReady = false;
      return ++v.file;
    },
    streamFromRange: function (id, url, offset, size, name) {
      var v = B.voice(id);
      var file = B.resetStream(v);
      v.name = name; v.state = 'decoding';
      if (diag) console.log('AUDIO: stream ' + id + ' "' + name + '" fetching ' + size + ' bytes from the archive');
      fetch(url, { headers: { 'Range': 'bytes=' + offset + '-' + (offset + size - 1) } })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          if (buf.byteLength > size) buf = buf.slice(offset, offset + size);   // a 200: the server ignored Range
          B.streamReady(v, file, new Uint8Array(buf));
        })
        .catch(function (e) { B.streamFailed(v, file, String(e)); });
    },
    streamFromBytes: function (id, ptr, size, name) {
      var v = B.voice(id);
      var file = B.resetStream(v);
      v.name = name; v.state = 'decoding';
      B.streamReady(v, file, HEAPU8.slice(ptr, ptr + size));
    },
    streamFailed: function (v, file, why) {
      if (v.file !== file) return;                   // closed or reopened meanwhile
      B.stats.streamErrors++;
      console.warn('AUDIO: stream "' + v.name + '" failed: ' + why);
      v.state = 'error';
      if (v.playWhenReady) { v.playWhenReady = false; B.eosLater(v); }
    },
    streamReady: function (v, file, bytes) {
      if (v.file !== file) return;                   // closed or reopened meanwhile
      var type = 'audio/mpeg';
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) type = 'audio/wav';
      else if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) type = 'audio/ogg';
      v.url = URL.createObjectURL(new Blob([bytes], { type: type }));
      var audio = new Audio();
      audio.preload = 'auto';
      audio.src = v.url;
      v.audio = audio;
      audio.addEventListener('loadedmetadata', function () {
        v.duration = audio.duration;
        if (diag) console.log('AUDIO: stream ' + v.id + ' "' + v.name + '" ready (' + type + ', ' + audio.duration.toFixed(1) + ' s)');
      });
      audio.addEventListener('error', function () {
        if (v.audio === audio) B.streamFailed(v, file, 'media error ' + (audio.error ? audio.error.code : '?'));
      });
      try {
        v.node = B.ctx.createMediaElementSource(audio);
        if (!v.gain) {
          v.gain = B.ctx.createGain();
          v.panner = B.ctx.createStereoPanner();
          v.panner.connect(v.gain);
          v.gain.connect(B.master);
        }
        v.node.connect(v.panner);
        v.gain.gain.value = v.volume;
        B.applyPlace(v);
      } catch (e) {
        console.warn('AUDIO: createMediaElementSource failed: ' + e);
      }
      v.state = 'ready';
      B.stats.streamsReady++;
      if (v.playWhenReady) { v.playWhenReady = false; B.startStream(v); }
    },
    playStream: function (v) {
      B.stats.streamsStarted++;
      v.gen++;
      v.left = v.loops;
      if (v.state === 'decoding') { v.playWhenReady = true; return; }
      if (v.state !== 'ready') { B.stats.notReady++; B.eosLater(v); return; }
      B.startStream(v);
    },
    startStream: function (v) {
      var audio = v.audio, gen = v.gen;
      if (B.ctx.state === 'suspended') B.ctx.resume().catch(function () {});
      audio.loop = v.loops === 0;
      try { audio.playbackRate = v.rate; } catch (e) {}
      audio.onended = function () {
        if (v.gen !== gen || v.audio !== audio) return;
        if (v.left > 1) { v.left--; audio.currentTime = 0; audio.play().catch(function () {}); return; }
        B.eos(v, gen);
      };
      if (diag) console.log('AUDIO: stream ' + v.id + ' "' + v.name + '" play');
      audio.play().catch(function (e) { if (diag) console.warn('AUDIO: stream play refused: ' + e); });
    },
    pauseStream: function (id, on) {
      var v = B.voices[id];
      if (!v || !v.audio) return 0;
      if (on) { try { v.audio.pause(); } catch (e) {} } else v.audio.play().catch(function () {});
      return 1;
    },
    streamPosition: function (id, which) {
      var v = B.voices[id];
      if (!v || !v.audio) return 0;
      var s = which ? v.audio.currentTime : (isFinite(v.duration) ? v.duration : 0);
      return Math.round(s * 1000);
    },
    seekStream: function (id, ms) { var v = B.voices[id]; if (v && v.audio) { try { v.audio.currentTime = ms / 1000; } catch (e) {} } },
    closeStream: function (id) { var v = B.voices[id]; if (v) { B.resetStream(v); delete B.voices[id]; } }
  };
  window['AILBridge'] = B;
  window['GX_audioStats'] = function () {
    var st = B.stats, playing = 0, streams = 0;
    for (var k in B.voices) {
      var v = B.voices[k];
      if (v.source) playing++;
      if (v.audio && !v.audio.paused && !v.audio.ended) { playing++; streams++; }
    }
    return { 'state': B.ctx ? B.ctx.state : 'none', 'started2D': st.started2D, 'started3D': st.started3D,
             'streamsStarted': st.streamsStarted, 'streamsReady': st.streamsReady, 'eos': st.eos, 'eos3D': st.eos3D, 'eosStream': st.eosStream, 'decoded': st.decoded,
             'cacheHits': st.cacheHits, 'decodeErrors': st.decodeErrors, 'streamErrors': st.streamErrors,
             'notReady': st.notReady, 'playing': playing, 'streamsPlaying': streams, 'maxRms': Math.round(st.maxRms * 10000) / 10000 };
  };
  window['GX_audioResetLevel'] = function () { B.stats.maxRms = 0; };
});

// ============================================================================================
// handles
// ============================================================================================
#define MAX_SAMPLES 128
#define MAX_STREAMS 32
#define JS_ID_3D 500
#define JS_ID_STREAM 1000
#define LISTENER_HANDLE ((H3DPOBJECT)9999)

struct SampleState {
    int id;                    // JS id: 1..128
    bool allocated;
    const void* file_image;
    AIL_sample_callback eos_callback;
    float volume;
    float pan;
    int loop_count;
    int playback_rate;
    int file_rate;             // the WAV's own rate; playback_rate / file_rate is the pitch
    bool is_playing;
};

struct Sample3DState {
    int id;                    // JS id: 501..628
    bool allocated;
    const void* file_image;
    AIL_3dsample_callback eos_callback;
    float volume;
    float max_dist;
    float min_dist;
    float x, y, z;
    int loop_count;
    int playback_rate;
    int file_rate;
    bool is_playing;
};

struct StreamState {
    int id;                    // JS id: 1001..1032
    bool allocated;
    char filename[256];
    AIL_stream_callback callback;
    float volume;
    float pan;
    int loop_count;
    bool is_playing;
};

static SampleState g_samples[MAX_SAMPLES];
static Sample3DState g_samples3D[MAX_SAMPLES];
static StreamState g_streams[MAX_STREAMS];

extern "C" EMSCRIPTEN_KEEPALIVE void AIL_trigger_sample_eos(int js_id) {
    if (js_id >= JS_ID_STREAM) {
        int i = js_id - JS_ID_STREAM - 1;
        if (i < 0 || i >= MAX_STREAMS) return;
        StreamState* s = &g_streams[i];
        if (!s->allocated) return;
        s->is_playing = false;
        if (s->callback) s->callback((HSTREAM)s);
    } else if (js_id >= JS_ID_3D) {
        int i = js_id - JS_ID_3D - 1;
        if (i < 0 || i >= MAX_SAMPLES) return;
        Sample3DState* s = &g_samples3D[i];
        if (!s->allocated) return;
        s->is_playing = false;
        if (s->eos_callback) s->eos_callback((H3DSAMPLE)s);
    } else {
        int i = js_id - 1;
        if (i < 0 || i >= MAX_SAMPLES) return;
        SampleState* s = &g_samples[i];
        if (!s->allocated) return;
        s->is_playing = false;
        if (s->eos_callback) s->eos_callback((HSAMPLE)s);
    }
}

// a RIFF image's total size (header says), or 0 when it is not one
static uint32_t riff_size(const void* file_image) {
    const uint8_t* p = (const uint8_t*)file_image;
    if (!p || memcmp(p, "RIFF", 4) != 0) return 0;
    return *(const uint32_t*)(p + 4) + 8;
}

static int wav_rate(const void* file_image) {
    WavHeaderInfo info;
    return parse_wav(file_image, info) && info.sample_rate > 0 ? info.sample_rate : 22050;
}

static void js_stop(int id) { EM_ASM({ window['AILBridge'].stop($0); }, id); }
static void js_volume_pan(int id, float volume, float pan) {
    EM_ASM({ window['AILBridge'].setVolumePan($0, $1, $2); }, id, volume, pan);
}
static void js_rate(int id, int rate, int file_rate) {
    EM_ASM({ window['AILBridge'].setRate($0, $1); }, id, file_rate > 0 ? (double)rate / file_rate : 1.0);
}
static void js_play(int id, int loop_count) {
    EM_ASM({ var B = window['AILBridge']; B.setLoops($0, $1); B.play($0); }, id, loop_count);
}

extern "C" {

// ---- 3D samples ------------------------------------------------------------------------------
F32 __stdcall AIL_3D_sample_volume(H3DSAMPLE sample) {
    return ((Sample3DState*)sample)->volume;
}

void __stdcall AIL_set_3D_sample_volume(H3DSAMPLE sample, F32 volume) {
    Sample3DState* s = (Sample3DState*)sample;
    s->volume = volume;
    js_volume_pan(s->id, volume, -1.0f);
}

void __stdcall AIL_end_3D_sample(H3DSAMPLE sample) {
    AIL_stop_3D_sample(sample);
}

void __stdcall AIL_resume_3D_sample(H3DSAMPLE sample) {
    AIL_start_3D_sample(sample);
}

void __stdcall AIL_stop_3D_sample(H3DSAMPLE sample) {
    Sample3DState* s = (Sample3DState*)sample;
    s->is_playing = false;
    js_stop(s->id);
}

void __stdcall AIL_start_3D_sample(H3DSAMPLE sample) {
    Sample3DState* s = (Sample3DState*)sample;
    s->is_playing = true;
    js_play(s->id, s->loop_count);
}

U32 __stdcall AIL_3D_sample_loop_count(H3DSAMPLE sample) {
    return ((Sample3DState*)sample)->loop_count;
}

void __stdcall AIL_set_3D_sample_offset(H3DSAMPLE sample, U32 offset) {
}

U32 __stdcall AIL_3D_sample_length(H3DSAMPLE sample) {
    return 0;
}

U32 __stdcall AIL_3D_sample_offset(H3DSAMPLE sample) {
    return 0;
}

S32 __stdcall AIL_3D_sample_playback_rate(H3DSAMPLE sample) {
    return ((Sample3DState*)sample)->playback_rate;
}

void __stdcall AIL_set_3D_sample_playback_rate(H3DSAMPLE sample, S32 playback_rate) {
    Sample3DState* s = (Sample3DState*)sample;
    s->playback_rate = playback_rate;
    js_rate(s->id, playback_rate, s->file_rate);
}

S32 __stdcall AIL_set_3D_sample_file(H3DSAMPLE sample, const void* file_image) {
    Sample3DState* s = (Sample3DState*)sample;
    s->file_image = file_image;
    s->file_rate = s->playback_rate = wav_rate(file_image);
    EM_ASM({ var B = window['AILBridge']; B.setSampleFile($0, $1, $2); B.setRate($0, 1); }, s->id, file_image, riff_size(file_image));
    return 1;
}

void __stdcall AIL_set_3D_sample_loop_count(H3DSAMPLE sample, U32 count) {
    ((Sample3DState*)sample)->loop_count = count;
}

void __stdcall AIL_set_3D_sample_effects_level(H3DSAMPLE sample, F32 effect_level) {
}

void __stdcall AIL_set_3D_sample_occlusion(H3DSAMPLE sample, F32 occlusion) {
}

void __stdcall AIL_set_3D_sample_distances(H3DSAMPLE sample, F32 max_dist, F32 min_dist) {
    Sample3DState* s = (Sample3DState*)sample;
    s->max_dist = max_dist;
    s->min_dist = min_dist;
    EM_ASM({ window['AILBridge'].setDistances($0, $1, $2); }, s->id, max_dist, min_dist);
}

void __stdcall AIL_set_3D_velocity_vector(H3DPOBJECT sample, F32 x, F32 y, F32 z) {
}

// Engine coordinates are Z-up; Web Audio's are Y-up: (X, Y, Z) -> (X, Z, -Y).
void __stdcall AIL_set_3D_position(H3DPOBJECT obj, F32 X, F32 Y, F32 Z) {
    if (obj == LISTENER_HANDLE) {
        EM_ASM({ window['AILBridge'].setListener($0, $1, $2, 0, 0, 0, 0, 0, 0, 0); }, X, Z, -Y);
    } else {
        Sample3DState* s = (Sample3DState*)obj;
        s->x = X; s->y = Z; s->z = -Y;
        EM_ASM({ window['AILBridge'].setPosition($0, $1, $2, $3); }, s->id, X, Z, -Y);
    }
}

void __stdcall AIL_set_3D_orientation(H3DPOBJECT obj, F32 X_face, F32 Y_face, F32 Z_face, F32 X_up, F32 Y_up, F32 Z_up) {
    if (obj != LISTENER_HANDLE) return;
    // the camera looks down at the map: keep the listener upright, facing the view's ground direction
    float len = sqrtf(X_face * X_face + Y_face * Y_face);
    float fx = 0.0f, fy = 1.0f;
    if (len > 0.0001f) { fx = X_face / len; fy = Y_face / len; }
    EM_ASM({ window['AILBridge'].setListener(0, 0, 0, $0, 0, $1, 0, 1, 0, 1); }, fx, -fy);
}

void __stdcall AIL_release_3D_sample_handle(H3DSAMPLE sample) {
    Sample3DState* s = (Sample3DState*)sample;
    s->eos_callback = nullptr;
    s->is_playing = false;
    s->allocated = false;
    js_stop(s->id);
}

H3DSAMPLE __stdcall AIL_allocate_3D_sample_handle(HPROVIDER lib) {
    for (int i = 0; i < MAX_SAMPLES; i++) {
        Sample3DState* s = &g_samples3D[i];
        if (s->allocated) continue;
        s->allocated = true;
        s->id = JS_ID_3D + i + 1;
        s->is_playing = false;
        s->volume = 1.0f;
        s->max_dist = 1000.0f;
        s->min_dist = 10.0f;
        s->x = s->y = s->z = 0.0f;
        s->loop_count = 1;
        s->playback_rate = s->file_rate = 22050;
        s->eos_callback = nullptr;
        s->file_image = nullptr;
        return (H3DSAMPLE)s;
    }
    return nullptr;
}

AIL_3dsample_callback __stdcall AIL_register_3D_EOS_callback(H3DSAMPLE sample, AIL_3dsample_callback EOS) {
    Sample3DState* s = (Sample3DState*)sample;
    AIL_3dsample_callback old = s->eos_callback;
    s->eos_callback = EOS;
    return old;
}

void __stdcall AIL_set_3D_user_data(H3DPOBJECT obj, U32 index, S32 value) {
}

S32 __stdcall AIL_3D_user_data(H3DPOBJECT sample, U32 index) {
    return 0;
}

// ---- 3D providers / listener ----------------------------------------------------------------
void __stdcall AIL_close_3D_provider(HPROVIDER lib) {
}

void __stdcall AIL_set_3D_speaker_type(HPROVIDER lib, S32 speaker_type) {
}

void __stdcall AIL_close_3D_listener(H3DPOBJECT listener) {
}

S32 __stdcall AIL_enumerate_3D_providers(HPROENUM* next, HPROVIDER* dest, char** name) {
    if (next && *next == 0) {
        *dest = (HPROVIDER)1;
        *name = (char*)"Miles Fast 2D Positional Audio";
        *next = (HPROENUM)1;
        return 1;
    }
    return 0;
}

M3DRESULT __stdcall AIL_open_3D_provider(HPROVIDER lib) {
    return 0;
}

H3DPOBJECT __stdcall AIL_open_3D_listener(HPROVIDER lib) {
    return LISTENER_HANDLE;
}

// ---- 2D samples -----------------------------------------------------------------------------
HSAMPLE __stdcall AIL_allocate_sample_handle(HDIGDRIVER dig) {
    for (int i = 0; i < MAX_SAMPLES; i++) {
        SampleState* s = &g_samples[i];
        if (s->allocated) continue;
        s->allocated = true;
        s->id = i + 1;
        s->is_playing = false;
        s->volume = 1.0f;
        s->pan = 0.5f;
        s->loop_count = 1;
        s->playback_rate = s->file_rate = 22050;
        s->eos_callback = nullptr;
        s->file_image = nullptr;
        return (HSAMPLE)s;
    }
    return nullptr;
}

void __stdcall AIL_release_sample_handle(HSAMPLE sample) {
    SampleState* s = (SampleState*)sample;
    s->eos_callback = nullptr;
    s->is_playing = false;
    s->allocated = false;
    js_stop(s->id);
}

void __stdcall AIL_init_sample(HSAMPLE sample) {
    SampleState* s = (SampleState*)sample;
    js_stop(s->id);
    s->file_image = nullptr;
    s->volume = 1.0f;
    s->pan = 0.5f;
    s->loop_count = 1;
    s->is_playing = false;
}

S32 __stdcall AIL_set_sample_file(HSAMPLE sample, const void * file_image, S32 block) {
    SampleState* s = (SampleState*)sample;
    s->file_image = file_image;
    s->file_rate = s->playback_rate = wav_rate(file_image);
    EM_ASM({ var B = window['AILBridge']; B.setSampleFile($0, $1, $2); B.setRate($0, 1); }, s->id, file_image, riff_size(file_image));
    return 1;
}

S32 __stdcall AIL_set_named_sample_file(HSAMPLE sample, const char* file_name, const void* file_image, S32 file_size, S32 block) {
    return AIL_set_sample_file(sample, file_image, block);
}

void __stdcall AIL_start_sample(HSAMPLE sample) {
    SampleState* s = (SampleState*)sample;
    s->is_playing = true;
    js_play(s->id, s->loop_count);
}

void __stdcall AIL_stop_sample(HSAMPLE sample) {
    SampleState* s = (SampleState*)sample;
    s->is_playing = false;
    js_stop(s->id);
}

void __stdcall AIL_end_sample(HSAMPLE sample) {
    AIL_stop_sample(sample);
}

void __stdcall AIL_resume_sample(HSAMPLE sample) {
    AIL_start_sample(sample);
}

void __stdcall AIL_set_sample_playback_rate(HSAMPLE sample, S32 playback_rate) {
    SampleState* s = (SampleState*)sample;
    s->playback_rate = playback_rate;
    js_rate(s->id, playback_rate, s->file_rate);
}

S32 __stdcall AIL_sample_playback_rate(HSAMPLE sample) {
    return ((SampleState*)sample)->playback_rate;
}

void __stdcall AIL_sample_ms_position(HSAMPLE sample, S32* total_ms, S32* current_ms) {
    if (total_ms) *total_ms = 0;
    if (current_ms) *current_ms = 0;
}

void __stdcall AIL_set_sample_ms_position(HSAMPLE sample, S32 pos) {
}

S32 __stdcall AIL_sample_loop_count(HSAMPLE sample) {
    return ((SampleState*)sample)->loop_count;
}

void __stdcall AIL_set_sample_loop_count(HSAMPLE sample, S32 count) {
    ((SampleState*)sample)->loop_count = count;
}

int __stdcall AIL_sample_volume(HSAMPLE sample) {
    return (int)(((SampleState*)sample)->volume * 127.0f);
}

void __stdcall AIL_set_sample_volume(HSAMPLE sample, int volume) {
    SampleState* s = (SampleState*)sample;
    s->volume = (float)volume / 127.0f;
    js_volume_pan(s->id, s->volume, s->pan);
}

int __stdcall AIL_sample_pan(HSAMPLE sample) {
    return (int)(((SampleState*)sample)->pan * 127.0f);
}

void __stdcall AIL_set_sample_pan(HSAMPLE sample, int pan) {
    SampleState* s = (SampleState*)sample;
    s->pan = (float)pan / 127.0f;
    js_volume_pan(s->id, s->volume, s->pan);
}

void __stdcall AIL_set_sample_volume_pan(HSAMPLE sample, F32 volume, F32 pan) {
    SampleState* s = (SampleState*)sample;
    s->volume = volume;
    s->pan = pan;
    js_volume_pan(s->id, volume, pan);
}

void __stdcall AIL_sample_volume_pan(HSAMPLE sample, F32 * volume, F32 * pan) {
    SampleState* s = (SampleState*)sample;
    if (volume) *volume = s->volume;
    if (pan) *pan = s->pan;
}

AIL_sample_callback __stdcall AIL_register_EOS_callback(HSAMPLE sample, AIL_sample_callback EOS) {
    SampleState* s = (SampleState*)sample;
    AIL_sample_callback old = s->eos_callback;
    s->eos_callback = EOS;
    return old;
}

HPROVIDER __stdcall AIL_set_sample_processor(HSAMPLE sample, SAMPLESTAGE pipeline_stage, HPROVIDER provider) {
    return 0;
}

void __stdcall AIL_set_filter_sample_preference(HSAMPLE sample, const char* name, const void* val) {
}

void __stdcall AIL_set_sample_user_data(HSAMPLE sample, U32 index, S32 value) {
}

S32 __stdcall AIL_sample_user_data(HSAMPLE sample, U32 index) {
    return 0;
}

void __stdcall AIL_get_DirectSound_info(HSAMPLE sample, AILLPDIRECTSOUND * lplpDS, AILLPDIRECTSOUNDBUFFER * lplpDSB) {
}

// ---- streams --------------------------------------------------------------------------------
HSTREAM __stdcall AIL_open_stream(HDIGDRIVER dig, const char * filename, S32 stream_mem) {
    if (!filename || !*filename) return nullptr;
    int slot = -1;
    for (int i = 0; i < MAX_STREAMS; i++) {
        if (!g_streams[i].allocated) { slot = i; break; }
    }
    if (slot < 0) {
        printf("[web_audio_bridge] AIL_open_stream: no free stream slot for '%s'\n", filename);
        return nullptr;
    }
    StreamState* s = &g_streams[slot];
    s->id = JS_ID_STREAM + slot + 1;

    // inside a mounted archive: the browser fetches the byte range itself, asynchronously
    const char* url = nullptr;
    uint32_t offset = 0, size = 0;
    if (WebAudioBridge_LocateFile(filename, &url, &offset, &size) && size > 0) {
        EM_ASM({ window['AILBridge'].streamFromRange($0, UTF8ToString($1), $2, $3, UTF8ToString($4)); },
               s->id, url, offset, size, filename);
    } else {
        // a loose file (user data, a local override): read it once through the engine's file system
        uint32_t bytes = 0;
        char* buf = WebAudioBridge_ReadEntireFile(filename, &bytes);
        if (!buf) {
            GX_DIAG_LOG("AUDIO: no file for stream '%s'\n", filename);
            return nullptr;
        }
        EM_ASM({ window['AILBridge'].streamFromBytes($0, $1, $2, UTF8ToString($3)); }, s->id, buf, bytes, filename);
        delete[] buf;
    }

    s->allocated = true;
    strncpy(s->filename, filename, sizeof(s->filename) - 1);
    s->filename[sizeof(s->filename) - 1] = 0;
    s->volume = 1.0f;
    s->pan = 0.5f;
    s->loop_count = 1;
    s->callback = nullptr;
    s->is_playing = false;
    EM_ASM({ window['AILBridge'].setVolumePan($0, 1, 0.5); }, s->id);
    return (HSTREAM)s;
}

HSTREAM __stdcall AIL_open_stream_by_sample(HDIGDRIVER driver, HSAMPLE sample, const char* file_name, int mem) {
    return 0;
}

void __stdcall AIL_close_stream(HSTREAM stream) {
    StreamState* s = (StreamState*)stream;
    s->allocated = false;
    s->callback = nullptr;
    s->is_playing = false;
    EM_ASM({ window['AILBridge'].closeStream($0); }, s->id);
}

void __stdcall AIL_start_stream(HSTREAM stream) {
    StreamState* s = (StreamState*)stream;
    s->is_playing = true;
    js_play(s->id, s->loop_count);
}

void __stdcall AIL_pause_stream(HSTREAM stream, S32 onoff) {
    StreamState* s = (StreamState*)stream;
    if (onoff) {
        EM_ASM({ window['AILBridge'].pauseStream($0, 1); }, s->id);
    } else if (s->is_playing) {
        if (!EM_ASM_INT({ return window['AILBridge'].pauseStream($0, 0); }, s->id)) AIL_start_stream(stream);
    } else {
        AIL_start_stream(stream);
    }
}

AIL_stream_callback __stdcall AIL_register_stream_callback(HSTREAM stream, AIL_stream_callback callback) {
    StreamState* s = (StreamState*)stream;
    AIL_stream_callback old = s->callback;
    s->callback = callback;
    return old;
}

void __stdcall AIL_set_stream_playback_rate(HSTREAM stream, S32 rate) {
}

S32 __stdcall AIL_stream_playback_rate(HSTREAM stream) {
    return 22050;
}

// Before the element has loaded its metadata the length is unknown and reported as 0.
void __stdcall AIL_stream_ms_position(HSTREAM stream, S32* total_milliseconds, S32* current_milliseconds) {
    StreamState* s = (StreamState*)stream;
    if (total_milliseconds) *total_milliseconds = EM_ASM_INT({ return window['AILBridge'].streamPosition($0, 0); }, s->id);
    if (current_milliseconds) *current_milliseconds = EM_ASM_INT({ return window['AILBridge'].streamPosition($0, 1); }, s->id);
}

void __stdcall AIL_set_stream_ms_position(HSTREAM stream, S32 pos) {
    EM_ASM({ window['AILBridge'].seekStream($0, $1); }, ((StreamState*)stream)->id, pos);
}

S32 __stdcall AIL_stream_loop_count(HSTREAM stream) {
    return ((StreamState*)stream)->loop_count;
}

void __stdcall AIL_set_stream_loop_block(HSTREAM stream, S32 loop_start, S32 loop_end) {
}

void __stdcall AIL_set_stream_loop_count(HSTREAM stream, S32 count) {
    ((StreamState*)stream)->loop_count = count;
}

int __stdcall AIL_stream_volume(HSTREAM stream) {
    return (int)(((StreamState*)stream)->volume * 127.0f);
}

void __stdcall AIL_set_stream_volume(HSTREAM stream, int volume) {
    StreamState* s = (StreamState*)stream;
    s->volume = (float)volume / 127.0f;
    js_volume_pan(s->id, s->volume, s->pan);
}

int __stdcall AIL_stream_pan(HSTREAM stream) {
    return (int)(((StreamState*)stream)->pan * 127.0f);
}

void __stdcall AIL_set_stream_pan(HSTREAM stream, int pan) {
    StreamState* s = (StreamState*)stream;
    s->pan = (float)pan / 127.0f;
    js_volume_pan(s->id, s->volume, s->pan);
}

void __stdcall AIL_set_stream_volume_pan(HSTREAM stream, F32 volume, F32 pan) {
    StreamState* s = (StreamState*)stream;
    s->volume = volume;
    s->pan = pan;
    js_volume_pan(s->id, volume, pan);
}

void __stdcall AIL_stream_volume_pan(HSTREAM stream, F32 * volume, F32 * pan) {
    StreamState* s = (StreamState*)stream;
    if (volume) *volume = s->volume;
    if (pan) *pan = s->pan;
}

// ---- misc ------------------------------------------------------------------------------------
S32 __stdcall AIL_set_preference(U32 number, S32 value) {
    return 1;
}

S32 __stdcall AIL_waveOutOpen(HDIGDRIVER* driver, LPHWAVEOUT* waveout, S32 id, LPWAVEFORMAT format) {
    return 0;
}

void __stdcall AIL_waveOutClose(HDIGDRIVER driver) {
}

S32 __stdcall AIL_WAV_info(const void* data, AILSOUNDINFO* info) {
    WavHeaderInfo wav;
    if (!parse_wav(data, wav)) return 0;
    info->format = wav.format;
    info->data_ptr = wav.data_ptr;
    info->data_len = wav.data_len;
    info->rate = wav.sample_rate;
    info->bits = wav.bits_per_sample;
    info->channels = wav.channels;
    info->initial_ptr = data;
    info->block_size = wav.block_align;
    if (wav.format == 1) {
        info->samples = wav.data_len / (wav.channels * (wav.bits_per_sample / 8));
    } else {
        info->samples = wav.data_len * 2;
    }
    return 1;
}

void __stdcall AIL_stop_timer(HTIMER timer) {
}

void __stdcall AIL_release_timer_handle(HTIMER timer) {
}

void __stdcall AIL_shutdown() {
}

S32 __stdcall AIL_enumerate_filters(HPROENUM* next, HPROVIDER* dest, char** name) {
    return 0;
}

void __stdcall AIL_set_file_callbacks(AIL_file_open_callback opencb, AIL_file_close_callback closecb, AIL_file_seek_callback seekcb, AIL_file_read_callback readcb) {
}

void __stdcall AIL_unlock() {
}

void __stdcall AIL_lock() {
}

char* __stdcall AIL_last_error() {
    return (char*)"No error";
}

S32 __stdcall AIL_decompress_ADPCM(const AILSOUNDINFO * info, void ** outdata, U32 * outsize) {
    if (!info || !info->data_ptr || info->data_len == 0) return 0;

    uint32_t block_align = info->block_size;
    if (block_align == 0) {
        if (info->channels == 1) block_align = 512;
        else block_align = 1024;
    }
    uint32_t num_blocks = info->data_len / block_align;
    uint32_t samples_per_block = 0;
    if (info->channels == 1) {
        samples_per_block = 1 + (block_align - 4) * 2;
    } else {
        samples_per_block = 1 + ((block_align - 8) / 16) * 16;
    }

    uint32_t total_samples = num_blocks * samples_per_block;
    uint32_t pcm_data_size = total_samples * info->channels * sizeof(int16_t);
    uint32_t total_wav_size = sizeof(WavHeader) + pcm_data_size;

    uint8_t* wav_buf = (uint8_t*)malloc(total_wav_size);
    if (!wav_buf) return 0;

    WavHeader* hdr = (WavHeader*)wav_buf;
    memcpy(hdr->riff, "RIFF", 4);
    hdr->riff_size = total_wav_size - 8;
    memcpy(hdr->wave, "WAVE", 4);
    memcpy(hdr->fmt, "fmt ", 4);
    hdr->fmt_size = 16;
    hdr->format_tag = 1; // PCM
    hdr->channels = info->channels;
    hdr->sample_rate = info->rate;
    hdr->byte_rate = info->rate * info->channels * sizeof(int16_t);
    hdr->block_align = info->channels * sizeof(int16_t);
    hdr->bits = 16;
    memcpy(hdr->data, "data", 4);
    hdr->data_size = pcm_data_size;

    int16_t* dst = (int16_t*)(wav_buf + sizeof(WavHeader));
    const uint8_t* src = (const uint8_t*)info->data_ptr;

    for (uint32_t b = 0; b < num_blocks; b++) {
        if (info->channels == 1) {
            decode_block_mono(src + b * block_align, block_align, dst + b * samples_per_block);
        } else {
            decode_block_stereo(src + b * block_align, block_align, dst + b * samples_per_block * 2);
        }
    }

    *outdata = wav_buf;
    *outsize = total_wav_size;
    return 1;
}

void __stdcall AIL_mem_free_lock(void * ptr) {
    if (ptr) free(ptr);
}

void __stdcall AIL_quick_unload(HAUDIO audio) {
}

HAUDIO __stdcall AIL_quick_load_and_play(const char * filename, U32 loop_count, S32 wait_request) {
    return nullptr;
}

void __stdcall AIL_quick_set_volume(HAUDIO audio, F32 volume, F32 extravol) {
}

static void bridge_start() {
#if GX_TRACE_LOGGING
    // Debug builds only: let the AILBridge EM_JS console traces through.
    EM_ASM({ window['gxAudioVerbose'] = true; });
#endif
    AILBridge_init();
    EM_ASM({ window['AILBridge'].init(); });
}

S32 __stdcall AIL_quick_startup(S32 use_digital, S32 use_MIDI, U32 output_rate, S32 output_bits, S32 output_channels) {
    bridge_start();
    return 1;
}

void __stdcall AIL_quick_handles(HDIGDRIVER * pdig, HMDIDRIVER * pmdi, HDLSDEVICE * pdls) {
    if (pdig) *pdig = (HDIGDRIVER)1;
    if (pmdi) *pmdi = (HMDIDRIVER)1;
    if (pdls) *pdls = (HDLSDEVICE)1;
}

char * __stdcall AIL_set_redist_directory(const char * dir) {
    return nullptr;
}

S32 __stdcall AIL_startup() {
    bridge_start();
    return 1;
}

U32 __stdcall AIL_get_timer_highest_delay() {
    return 0;
}

} // extern "C"

// GeneralsX @merge 2026-10-21 — declared by upstream's mss.h; the web build is single-threaded.
void __stdcall AIL_lock_mutex(void) {}
void __stdcall AIL_unlock_mutex(void) {}
