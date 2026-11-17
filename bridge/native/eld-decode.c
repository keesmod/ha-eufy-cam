/*
 * Decodes raw AAC-ELD access units to PCM with Fraunhofer FDK AAC (#264).
 *
 *   eufy-eld-decode CONFIG INPUT OUTPUT
 *
 * CONFIG is the AudioSpecificConfig in hexadecimal. INPUT holds access units,
 * each preceded by its length as a 16-bit big-endian number. OUTPUT receives
 * interleaved signed 16-bit little-endian PCM. A unit that does not decode
 * becomes silence of one frame, so later audio keeps its position. On success
 * the only stdout line is "rate=R channels=C frame=F units=U errors=E".
 * Exit codes: 0 success, 2 usage, 3 config, 4 input, 5 output, 6 no audio.
 */
#include <fdk-aac/aacdecoder_lib.h>
#include <stdio.h>
#include <string.h>

#define MAX_CONFIG 64
#define MAX_UNIT 8192
#define MAX_SAMPLES (8 * 2048)

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

int main(int argc, char **argv) {
  if (argc != 4) return 2;
  size_t length = strlen(argv[1]);
  if (length == 0 || length % 2 || length / 2 > MAX_CONFIG) return 3;
  UCHAR config[MAX_CONFIG];
  for (size_t i = 0; i < length / 2; i++) {
    int high = hex(argv[1][2 * i]), low = hex(argv[1][2 * i + 1]);
    if (high < 0 || low < 0) return 3;
    config[i] = (UCHAR)(high << 4 | low);
  }
  HANDLE_AACDECODER decoder = aacDecoder_Open(TT_MP4_RAW, 1);
  if (!decoder) return 3;
  UCHAR *configs[] = {config};
  UINT sizes[] = {(UINT)(length / 2)};
  if (aacDecoder_ConfigRaw(decoder, configs, sizes) != AAC_DEC_OK) return 3;
  CStreamInfo *info = aacDecoder_GetStreamInfo(decoder);
  if (!info || info->aacSamplesPerFrame <= 0 || info->channelConfig < 1 || info->channelConfig > 2) return 3;
  FILE *in = fopen(argv[2], "rb");
  if (!in) return 4;
  FILE *out = fopen(argv[3], "wb");
  if (!out) return 5;

  static UCHAR unit[MAX_UNIT];
  static INT_PCM pcm[MAX_SAMPLES];
  static const INT_PCM silence[MAX_SAMPLES];
  unsigned long units = 0, errors = 0;
  int rate = 0, channels = 0, frame = 0;
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
  }
  aacDecoder_Close(decoder);
  fclose(in);
  if (fclose(out)) return 5;
  if (!rate) return 6;
  printf("rate=%d channels=%d frame=%d units=%lu errors=%lu\n", rate, channels, frame, units, errors);
  return 0;
}
