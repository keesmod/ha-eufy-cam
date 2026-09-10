import { spawn } from 'node:child_process';
export interface RecordingMetadata {
  videoCodec: 'h264' | 'hevc' | null;
  fps: number;
}
const LIMIT = 32 * 1024 * 1024;
export async function muxRecording(
  metadata: RecordingMetadata,
  video: Buffer,
  audio: Buffer,
  signal: AbortSignal,
  format: 'h264' | 'native' = 'h264',
): Promise<Buffer> {
  signal.throwIfAborted();
  const codec =
    metadata.videoCodec === 'h264' ? 'h264' : metadata.videoCodec === 'hevc' ? 'hevc' : null;
  if (!codec) throw new Error('Unsupported recording codec');
  const transcode = codec === 'hevc' && format === 'h264';
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-r',
      String(metadata.fps || 15),
      '-f',
      codec,
      '-i',
      'pipe:0',
    ];
    if (audio.length) args.push('-f', 'aac', '-i', 'pipe:3');
    args.push('-map', '0:v:0', '-c:v', transcode ? 'libx264' : 'copy');
    if (codec === 'hevc' && !transcode) args.push('-tag:v', 'hvc1');
    if (transcode) args.push('-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '2');
    if (audio.length) args.push('-map', '1:a:0', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc');
    // Playback starts after the complete clip is buffered. A single fragment lets
    // native Apple players determine the full duration instead of stopping early.
    // Oversized output must flush and hit our byte cap before FFmpeg buffers more.
    args.push(
      '-movflags',
      'frag_custom+empty_moov+default_base_moof',
      '-frag_size',
      String(LIMIT),
      '-f',
      'mp4',
      'pipe:1',
    );
    const process = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      process.kill('SIGKILL');
      reject(new Error('Recording conversion failed'));
    };
    const timer = setTimeout(fail, transcode ? 45_000 : 20_000);
    signal.addEventListener('abort', fail, { once: true });
    process.stdout!.on('data', (b: Buffer) => {
      size += b.length;
      if (size > LIMIT) fail();
      else parts.push(b);
    });
    process.stderr!.resume();
    process.once('error', fail);
    process.once('close', (code) => {
      if (settled) return;
      if (code !== 0 || !size) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      resolve(Buffer.concat(parts));
    });
    process.stdin!.on('error', fail);
    process.stdin!.end(video);
    const input = process.stdio[3] as import('node:stream').Writable;
    input.on('error', fail);
    input.end(audio);
  });
}
