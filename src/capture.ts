/**
 * Screenshot of a process's main window, without native code: Windows PowerShell (present on every
 * Windows) calls user32 PrintWindow with PW_RENDERFULLCONTENT, which also captures DirectX / OpenGL
 * windows, scales the image down and writes the PNG as base64 on stdout. Nothing touches the disk.
 *
 * CE's D3D hook draws overlays but offers no capture (celua.txt), hence a window capture: it works
 * whatever the graphics API, as long as the window is not minimized.
 */

import { execFile } from 'child_process';
import { join } from 'path';

const CAPTURE_TIMEOUT_MS = 30_000;

/** Windows PowerShell 5.1 ships with every Windows; its absolute path does not depend on PATH. */
function powershellPath(): string {
  return join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function script(pid: number, maxWidth: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CemcpWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
}
'@
$process = Get-Process -Id ${pid}
$hwnd = $process.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw 'the process has no main window' }
if ([CemcpWin]::IsIconic($hwnd)) { throw 'the window is minimized' }
$rect = New-Object CemcpWin+RECT
[void][CemcpWin]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { throw 'the window has no size' }
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$ok = [CemcpWin]::PrintWindow($hwnd, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
if (-not $ok) { throw 'PrintWindow failed' }
if ($width -gt ${maxWidth}) {
  $scaledHeight = [int][Math]::Round($height * ${maxWidth} / $width)
  $scaled = New-Object System.Drawing.Bitmap ${maxWidth}, $scaledHeight
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($bitmap, 0, 0, ${maxWidth}, $scaledHeight)
  $g.Dispose()
  $bitmap.Dispose()
  $bitmap = $scaled
}
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write("$($width)x$($height) $($bitmap.Width)x$($bitmap.Height) " + [Convert]::ToBase64String($stream.ToArray()))
`;
}

export interface Capture {
  png: Buffer;
  /** Window size, and size of the returned image after scaling. */
  window: { width: number; height: number };
  image: { width: number; height: number };
}

export function captureWindow(pid: number, maxWidth: number): Promise<Capture> {
  if (process.platform !== 'win32') return Promise.reject(new Error('screenshots are only supported on Windows'));
  const encoded = Buffer.from(script(pid, maxWidth), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // PowerShell reports a thrown error on stderr, keep its first meaningful line
          const reason = stderr.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('At line')) ?? err.message;
          reject(new Error(`screenshot failed: ${reason.trim()}`));
          return;
        }
        const match = /^(\d+)x(\d+) (\d+)x(\d+) ([A-Za-z0-9+/=]+)$/.exec(stdout.trim());
        if (!match) {
          reject(new Error(`screenshot failed: unexpected output (${stdout.slice(0, 80)})`));
          return;
        }
        resolve({
          window: { width: Number(match[1]), height: Number(match[2]) },
          image: { width: Number(match[3]), height: Number(match[4]) },
          png: Buffer.from(match[5], 'base64'),
        });
      },
    );
  });
}
