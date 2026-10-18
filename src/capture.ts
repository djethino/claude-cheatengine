/**
 * Screenshot of a process's main window, without native code: Windows PowerShell (present on every
 * Windows) calls user32 PrintWindow with PW_RENDERFULLCONTENT, which also captures DirectX / OpenGL
 * windows, scales the image down and writes the PNG as base64 on stdout. Nothing touches the disk.
 *
 * CE's D3D hook draws overlays but offers no capture (celua.txt), hence a window capture: it works
 * whatever the graphics API, as long as the window is not minimized.
 */

import { execFile } from 'child_process';
import { powershellPath } from './win/helper.js';

const CAPTURE_TIMEOUT_MS = 30_000;

/** Part of the window image to keep, in pixels of the client area (or of the whole window). */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  maxWidth: number;
  /** Only the client area (the game's picture, without title bar and borders). */
  clientOnly: boolean;
  region?: Region;
}

/** PowerShell: narrow the area ($x0, $y0, $width, $height) to the region, clipped to the area. */
function regionScript({ x, y, width, height }: Region, areaName: string): string {
  return `if (${x} -ge $width -or ${y} -ge $height) { throw "the region starts outside the ${areaName} ($($width)x$($height))" }
$x0 += ${x}; $y0 += ${y}
$width = [Math]::Min(${width}, $width - ${x}); $height = [Math]::Min(${height}, $height - ${y})`;
}

function script(pid: number, { maxWidth, clientOnly, region }: CaptureOptions): string {
  return `
$ErrorActionPreference = 'Stop'
# With stderr redirected, PowerShell writes its errors there as CLIXML: report them on stdout instead
trap { [Console]::Out.Write('ERROR ' + $_.Exception.Message); exit 1 }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CemcpWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  // The largest visible top-level window of the process (Windows' "main window" of a Lazarus or
  // Delphi program is a hidden zero-size application window); a minimized one only if none is shown
  public static IntPtr GameWindow(uint pid) {
    IntPtr best = IntPtr.Zero, minimized = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((hwnd, l) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != pid || !IsWindowVisible(hwnd)) return true;
      if (IsIconic(hwnd)) { minimized = hwnd; return true; }
      RECT r;
      GetWindowRect(hwnd, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = hwnd; }
      return true;
    }, IntPtr.Zero);
    return best != IntPtr.Zero ? best : minimized;
  }
}
'@
# Real pixels: without it, a scaled display (125%, 150%) gives virtualized sizes and a cut image
[void][CemcpWin]::SetProcessDPIAware()
$hwnd = [CemcpWin]::GameWindow(${pid})
if ($hwnd -eq [IntPtr]::Zero) { throw 'the process has no visible window' }
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
# Area kept: the client area (position inside the window image) or the whole window, then the region
$x0 = 0; $y0 = 0; $areaWidth = $width; $areaHeight = $height
if (${clientOnly ? '$true' : '$false'}) {
  $client = New-Object CemcpWin+RECT
  [void][CemcpWin]::GetClientRect($hwnd, [ref]$client)
  $origin = New-Object CemcpWin+POINT
  [void][CemcpWin]::ClientToScreen($hwnd, [ref]$origin)
  $x0 = $origin.X - $rect.Left; $y0 = $origin.Y - $rect.Top
  $areaWidth = $client.Right; $areaHeight = $client.Bottom
  if ($areaWidth -le 0 -or $areaHeight -le 0) { throw 'the window has no client area' }
}
$width = $areaWidth; $height = $areaHeight
${region ? regionScript(region, clientOnly ? 'client area' : 'window') : ''}
if ($x0 -ne 0 -or $y0 -ne 0 -or $width -ne $bitmap.Width -or $height -ne $bitmap.Height) {
  $cropped = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($cropped)
  $g.DrawImage($bitmap, (New-Object System.Drawing.Rectangle 0, 0, $width, $height), (New-Object System.Drawing.Rectangle $x0, $y0, $width, $height), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bitmap.Dispose()
  $bitmap = $cropped
}
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
  /** Size of the captured area (window, client area or region), and of the returned image after scaling. */
  area: { width: number; height: number };
  image: { width: number; height: number };
}

export function captureWindow(pid: number, options: CaptureOptions): Promise<Capture> {
  if (process.platform !== 'win32') return Promise.reject(new Error('screenshots are only supported on Windows'));
  const encoded = Buffer.from(script(pid, options), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // The script's own errors come on stdout; anything else (PowerShell missing, timeout) is err
          const reason = /^ERROR (.*)$/s.exec(stdout.trim())?.[1] ?? (stderr.trim() || err.message);
          reject(new Error(`screenshot failed: ${reason.trim()}`));
          return;
        }
        const match = /^(\d+)x(\d+) (\d+)x(\d+) ([A-Za-z0-9+/=]+)$/.exec(stdout.trim());
        if (!match) {
          reject(new Error(`screenshot failed: unexpected output (${stdout.slice(0, 80)})`));
          return;
        }
        resolve({
          area: { width: Number(match[1]), height: Number(match[2]) },
          image: { width: Number(match[3]), height: Number(match[4]) },
          png: Buffer.from(match[5], 'base64'),
        });
      },
    );
  });
}
