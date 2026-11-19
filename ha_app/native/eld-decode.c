/*
 * Decodes raw AAC-ELD access units to PCM with Fraunhofer FDK AAC (#264, #269).
 *
 *   eufy-eld-decode CONFIG INPUT OUTPUT
 *   eufy-eld-decode --stream CONFIG RATE CHANNELS
 *
 * CONFIG is the AudioSpecificConfig in hexadecimal. INPUT holds access units,
 * each preceded by its length as a 16-bit big-endian number. OUTPUT receives
 * interleaved signed 16-bit little-endian PCM. A unit that does not decode
 * becomes silence of one frame, so later audio keeps its position. On success
 * the only stdout line is "rate=R channels=C frame=F units=U errors=E".
 *
 * The stream mode reads the same units from stdin and writes the PCM of each
 * unit to stdout as soon as it is decoded, for live audio. CONFIG must give
 * RATE and CHANNELS, so the reader knows the PCM format before the first unit,
 * and a decoded frame in another format counts as an error. Every 100 units
 * and at the end of the input it writes "units=U errors=E" to stderr. From the
 * 50th unit on, more than one error in ten units ends it with exit code 7.
 *
 * Exit codes: 0 success, 2 usage, 3 config, 4 input, 5 output, 6 no audio,
 * 7 too many errors.
 */
// SIGPIPE is POSIX, and the image compiles with -std=c11.
#define _POSIX_C_SOURCE 200809L
#include <fdk-aac/aacdecoder_lib.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_CONFIG 64
#define MAX_UNIT 8192
#define MAX_SAMPLES (8 * 2048)
#define REPORT_UNITS 100
#define ERROR_MIN_UNITS 50

static int hex(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int write_pcm(FILE *out, const INT_PCM *pcm, size_t samples) {
  unsigned char bytes[2];
  for (size_t i = 0; i < samples; i++) {
    unsigned short value = (unsigned short)pcm[i];
    bytes[0] = (unsigned char)(value & 0xff);
    bytes[1] = (unsigned char)(value >> 8);
    if (fwrite(bytes, 1, 2, out) != 2) return -1;
  }
  return 0;
}

/* A whole number from 1 to max, or -1. */
static long number(const char *text, long max) {
  char *end;
  long value = strtol(text, &end, 10);
  return *text && !*end && value >= 1 && value <= max ? value : -1;
}

int main(int argc, char **argv) {
  int stream = argc == 5 && strcmp(argv[1], "--stream") == 0;
  if (!stream && argc != 4) return 2;
  const char *text = argv[stream ? 2 : 1];
  size_t length = strlen(text);
  if (length == 0 || length % 2 || length / 2 > MAX_CONFIG) return 3;
  UCHAR config[MAX_CONFIG];
  for (size_t i = 0; i < length / 2; i++) {
    int high = hex(text[2 * i]), low = hex(text[2 * i + 1]);
    if (high < 0 || low < 0) return 3;
    config[i] = (UCHAR)(high << 4 | low);
  }
  long want_rate = stream ? number(argv[3], 96000) : 0, want_channels = stream ? number(argv[4], 2) : 0;
  if (want_rate < 0 || want_channels < 0) return 2;
  HANDLE_AACDECODER decoder = aacDecoder_Open(TT_MP4_RAW, 1);
  if (!decoder) return 3;
  UCHAR *configs[] = {config};
  UINT sizes[] = {(UINT)(length / 2)};
  if (aacDecoder_ConfigRaw(decoder, configs, sizes) != AAC_DEC_OK) return 3;
  CStreamInfo *info = aacDecoder_GetStreamInfo(decoder);
  if (!info || info->aacSamplesPerFrame <= 0 || info->channelConfig < 1 || info->channelConfig > 2) return 3;
  int rate = 0, channels = 0, frame = 0;
  FILE *in, *out;
  if (stream) {
    // An extension such as LD-SBR would change the output rate.
    if (info->aacSampleRate != want_rate || (info->extSamplingRate && info->extSamplingRate != want_rate) ||
        info->channelConfig != want_channels)
      return 3;
    rate = (int)want_rate;
    channels = (int)want_channels;
    frame = info->aacSamplesPerFrame;
    // A closed reader then fails the write with exit code 5.
    signal(SIGPIPE, SIG_IGN);
    in = stdin;
    out = stdout;
  } else {
    in = fopen(argv[2], "rb");
    if (!in) return 4;
    out = fopen(argv[3], "wb");
    if (!out) return 5;
  }

  static UCHAR unit[MAX_UNIT];
  static INT_PCM pcm[MAX_SAMPLES];
  static const INT_PCM silence[MAX_SAMPLES];
  unsigned long units = 0, errors = 0;
  // Before the first decoded frame the config gives the frame of a lost unit.
  size_t lost = (size_t)info->aacSamplesPerFrame * (size_t)info->channelConfig;
  for (;;) {
    unsigned char prefix[2];
    size_t got = fread(prefix, 1, 2, in);
    if (got == 0 && feof(in)) break;
    if (got != 2) return 4;
    UINT size = (UINT)prefix[0] << 8 | prefix[1];
    if (size == 0 || size > MAX_UNIT || fread(unit, 1, size, in) != size) return 4;
    units++;
    UCHAR *buffers[] = {unit};
    UINT valid = size;
    AAC_DECODER_ERROR error = aacDecoder_Fill(decoder, buffers, &size, &valid);
    if (error == AAC_DEC_OK) error = aacDecoder_DecodeFrame(decoder, pcm, MAX_SAMPLES, 0);
    info = aacDecoder_GetStreamInfo(decoder);
    int decoded = error == AAC_DEC_OK && info && info->frameSize > 0 && info->numChannels > 0 &&
                  (size_t)info->frameSize * (size_t)info->numChannels <= MAX_SAMPLES &&
                  (!rate || (info->sampleRate == rate && info->numChannels == channels && info->frameSize == frame));
    if (decoded) {
      if (!rate) {
        rate = info->sampleRate;
        channels = info->numChannels;
        frame = info->frameSize;
        lost = (size_t)frame * (size_t)channels;
      }
      if (write_pcm(out, pcm, (size_t)frame * (size_t)channels)) return 5;
    } else {
      errors++;
      if (lost > MAX_SAMPLES || write_pcm(out, silence, lost)) return 5;
    }
    if (stream) {
      if (fflush(out)) return 5;
      if (units % REPORT_UNITS == 0) fprintf(stderr, "units=%lu errors=%lu\n", units, errors);
      if (units >= ERROR_MIN_UNITS && errors * 10 > units) {
        fprintf(stderr, "units=%lu errors=%lu\n", units, errors);
        return 7;
      }
    }
  }
  aacDecoder_Close(decoder);
  if (stream) {
    fprintf(stderr, "units=%lu errors=%lu\n", units, errors);
    return fflush(out) ? 5 : 0;
  }
  fclose(in);
  if (fclose(out)) return 5;
  if (!rate) return 6;
  printf("rate=%d channels=%d frame=%d units=%lu errors=%lu\n", rate, channels, frame, units, errors);
  return 0;
}
