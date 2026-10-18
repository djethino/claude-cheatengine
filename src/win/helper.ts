/**
 * Windows-side helpers without native code: a long-lived Windows PowerShell process (present on
 * every Windows) that compiles a few user32 calls once, then answers one JSON request per line.
 *
 * It sees Cheat Engine's windows from the outside, so it works while CE's main thread is blocked
 * by a dialog (the pipe cannot answer then): listing CE's dialogs and clicking a button.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { join } from 'path';

/** Windows PowerShell 5.1 ships with every Windows; its absolute path does not depend on PATH. */
export function powershellPath(): string {
  return join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const REQUEST_TIMEOUT_MS = 30_000;

const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CemcpUi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  public static string Text(IntPtr h) { var b = new StringBuilder(4096); GetWindowText(h, b, b.Capacity); return b.ToString(); }
  public static string Class(IntPtr h) { var b = new StringBuilder(256); GetClassName(h, b, b.Capacity); return b.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Push buttons: class Button (Win32 and LCL TButton) or TBitBtn, without the checkbox/radio styles
  public static bool IsPushButton(IntPtr h) {
    string c = Class(h);
    if (c.IndexOf("BitBtn", StringComparison.OrdinalIgnoreCase) >= 0) return true;
    if (!c.Equals("Button", StringComparison.OrdinalIgnoreCase)) return false;
    int kind = GetWindowLong(h, -16) & 0xF;
    return kind == 0 || kind == 1 || kind == 0xB;
  }
  public static List<IntPtr> TopWindows(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { if (Pid(h) == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
[void][CemcpUi]::SetProcessDPIAware()

# The dialogs blocking CE: a modal dialog disables the window that owns it (CE's main form), so a
# dialog is a visible, enabled window of the process whose owner, of the same process, is disabled.
# Non-modal windows (Lua engine, progress windows) are owned by the application window, which stays
# enabled. CE's dialogs are LCL forms: their labels are not windows, the text is only in the image
function Get-Dialogs($pid_, $withImage) {
  $out = @()
  foreach ($h in [CemcpUi]::TopWindows([uint32]$pid_)) {
    if (-not [CemcpUi]::IsWindowEnabled($h)) { continue }
    $owner = [CemcpUi]::GetWindow($h, 4)
    if ($owner -eq [IntPtr]::Zero -or [CemcpUi]::Pid($owner) -ne [uint32]$pid_ -or [CemcpUi]::IsWindowEnabled($owner)) { continue }
    $texts = @(); $buttons = @(); $buttonHandles = @()
    foreach ($c in [CemcpUi]::Children($h)) {
      $t = [CemcpUi]::Text($c)
      if ([CemcpUi]::IsPushButton($c)) { $buttons += @{ id = [string][long]$c; text = $t }; $buttonHandles += $c }
      elseif ($t.Trim() -ne '') { $texts += $t }
    }
    $d = @{ id = [string][long]$h; pid = [int]$pid_; title = [CemcpUi]::Text($h); texts = $texts; buttons = $buttons }
    if ($withImage) {
      $r = New-Object CemcpUi+RECT
      [void][CemcpUi]::GetWindowRect($h, [ref]$r)
      $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
      if ($w -gt 0 -and $hh -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap $w, $hh
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        [void][CemcpUi]::PrintWindow($h, $hdc, 2)
        $g.ReleaseHdc($hdc)
        # The dialog's print sometimes leaves a button out (seen live with CE's LCL dialogs): print
        # every button by itself over it, so the choices are always in the image
        foreach ($c in $buttonHandles) {
          $cr = New-Object CemcpUi+RECT
          [void][CemcpUi]::GetWindowRect($c, [ref]$cr)
          $cw = $cr.Right - $cr.Left; $ch = $cr.Bottom - $cr.Top
          if ($cw -le 0 -or $ch -le 0) { continue }
          $cb = New-Object System.Drawing.Bitmap $cw, $ch
          $cg = [System.Drawing.Graphics]::FromImage($cb)
          $cdc = $cg.GetHdc()
          $printed = [CemcpUi]::PrintWindow($c, $cdc, 2)
          $cg.ReleaseHdc($cdc); $cg.Dispose()
          if ($printed) { $g.DrawImage($cb, $cr.Left - $r.Left, $cr.Top - $r.Top) }
          $cb.Dispose()
        }
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $d.image = [Convert]::ToBase64String($ms.ToArray())
      }
    }
    $out += $d
  }
  return $out
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $req = $line | ConvertFrom-Json
    switch ($req.cmd) {
      'dialogs' { $result = @(foreach ($p in $req.pids) { Get-Dialogs $p $req.image }) }
      'close' {
        $h = [IntPtr][long]$req.id
        if (-not [CemcpUi]::IsWindow($h)) { throw 'the dialog no longer exists' }
        # WM_CLOSE, posted (the dialog's own message loop handles it, nothing waits on CE): what
        # its close button does. LCL buttons ignore a BM_CLICK sent from another process
        [void][CemcpUi]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
        $result = $true
      }
      'ceProcesses' { $result = @(Get-Process | Where-Object { $_.ProcessName -like 'cheatengine*' } | ForEach-Object { $_.Id }) }
      default { throw ('unknown command ' + $req.cmd) }
    }
    $reply = @{ ok = $true; result = $result }
  } catch {
    $reply = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 6 -Compress))
  [Console]::Out.Flush()
}
`;

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** One PowerShell process for the server's lifetime, started on first use; requests in order. */
class WinHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout = '';
  private readonly waiting: Waiting[] = [];

  async request<T>(command: Record<string, unknown>): Promise<T> {
    if (process.platform !== 'win32') throw new Error('only supported on Windows');
    const child = this.child ?? this.start();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(new Error('the Windows helper did not answer'));
      }, REQUEST_TIMEOUT_MS);
      this.waiting.push({ resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  stop(err = new Error('Windows helper stopped')): void {
    const child = this.child;
    this.child = null;
    this.stdout = '';
    child?.removeAllListeners();
    child?.kill();
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.resume();
    child.on('exit', () => this.stop(new Error('the Windows helper exited')));
    child.on('error', (err) => this.stop(new Error(`the Windows helper failed to start: ${err.message}`)));
    // Never keep the server alive for it
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stderr as unknown as { unref?: () => void }).unref?.();
    this.child = child;
    return child;
  }

  private onData(chunk: string): void {
    this.stdout += chunk;
    let newline: number;
    while ((newline = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      const w = this.waiting.shift();
      if (!w) continue;
      clearTimeout(w.timer);
      try {
        const reply = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) w.resolve(reply.result);
        else w.reject(new Error(reply.error ?? 'unknown error'));
      } catch {
        w.reject(new Error(`unexpected answer from the Windows helper: ${line.slice(0, 80)}`));
      }
    }
  }
}

export const winHelper = new WinHelper();

/** PIDs of the running Cheat Engine processes (empty off Windows). */
export async function ceProcesses(): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  return winHelper.request<number[]>({ cmd: 'ceProcesses' });
}
