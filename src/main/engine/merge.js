'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

// All of these are stream copies: no re-encoding, so they run at disk speed and
// lose nothing. Fletch never transcodes behind the user's back.

function runFfmpeg(ffmpegPath, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'warning', '-y', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-8000);
      if (onLine) String(d).split(/\r?\n/).forEach((l) => l && onLine(l));
    });
    child.on('error', (e) => reject(new Error(`Could not run ffmpeg: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const msg = err.split('\n').filter(Boolean).slice(-3).join(' ');
      reject(new Error(msg || `ffmpeg exited with code ${code}`));
    });
  });
}

/** Put a video-only and an audio-only file back together into one container. */
async function mergeTracks(ffmpegPath, videoPath, audioPath, outPath, onLine) {
  const ext = path.extname(outPath).toLowerCase();
  const args = ['-i', videoPath, '-i', audioPath, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0'];
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') args.push('-movflags', '+faststart');
  args.push(outPath);
  await runFfmpeg(ffmpegPath, args, onLine);
  return outPath;
}

/**
 * Rewrap a transport stream as MP4 so it seeks properly and plays everywhere.
 * Falls back to keeping the .ts if the copy is refused.
 */
async function remuxToMp4(ffmpegPath, inPath, outPath, onLine) {
  // aac_adtstoasc is needed for AAC carried in a transport stream, but it is an
  // error for anything else (AC-3, or AAC already in an MP4 fragment), so fall
  // back to a plain copy rather than failing the download over it.
  try {
    await runFfmpeg(
      ffmpegPath,
      ['-i', inPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outPath],
      onLine
    );
  } catch {
    await runFfmpeg(
      ffmpegPath,
      ['-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath],
      onLine
    );
  }
  return outPath;
}

/** Pull the audio out of a container without re-encoding it. */
async function extractAudio(ffmpegPath, inPath, outPath, onLine) {
  await runFfmpeg(ffmpegPath, ['-i', inPath, '-vn', '-c:a', 'copy', outPath], onLine);
  return outPath;
}

async function replace(tempPath, finalPath) {
  await fsp.rm(finalPath, { force: true }).catch(() => {});
  await fsp.rename(tempPath, finalPath);
}

module.exports = { mergeTracks, remuxToMp4, extractAudio, runFfmpeg, replace };
