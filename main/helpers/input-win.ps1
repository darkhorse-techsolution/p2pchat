# P2P Chat input helper for Windows: posts the mouse and keyboard events of a screen-share
# remote control with SendInput. Run by the app as
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File input-win.ps1
#
# Protocol (one command per line on stdin, numbers are physical screen pixels, see main/input.js):
#   m X Y            move the pointer
#   d B X Y          button B (0 left, 1 right, 2 middle) down at X Y
#   u B X Y          button up
#   w DX DY X Y      wheel, DX/DY in pixels (positive = content scrolls right / down)
#   k SCAN EXT 1|0   key down / up, SCAN = scan code, EXT = 1 for the extended (E0) keys
#   r                release everything held
# "ready" and errors go to stderr. Everything held is released at "r" and at end of input.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class P2PInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static uint Mouse(uint flags, int x, int y, int data) {
    INPUT[] a = new INPUT[1]; a[0].type = 0;
    a[0].u.mi.dx = x; a[0].u.mi.dy = y; a[0].u.mi.mouseData = unchecked((uint)data); a[0].u.mi.dwFlags = flags;
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Key(ushort scan, bool ext, bool up) {
    INPUT[] a = new INPUT[1]; a[0].type = 1;
    a[0].u.ki.wScan = scan; a[0].u.ki.dwFlags = 8u | (ext ? 1u : 0u) | (up ? 2u : 0u);   // SCANCODE | EXTENDEDKEY | KEYUP
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[void][P2PInput]::SetProcessDPIAware()
$MOVE = 0x0001; $ABS = 0x8000; $VDESK = 0x4000; $WHEEL = 0x0800; $HWHEEL = 0x1000
$DOWN = @{ 0 = 0x0002; 1 = 0x0008; 2 = 0x0020 }; $UP = @{ 0 = 0x0004; 1 = 0x0010; 2 = 0x0040 }
$held = @{}; $heldKeys = @{}
function Abs([int]$x, [int]$y) {
  $vx = [P2PInput]::GetSystemMetrics(76); $vy = [P2PInput]::GetSystemMetrics(77)
  $vw = [Math]::Max(1, [P2PInput]::GetSystemMetrics(78)); $vh = [Math]::Max(1, [P2PInput]::GetSystemMetrics(79))
  return @([int](($x - $vx) * 65535 / $vw), [int](($y - $vy) * 65535 / $vh))
}
function Move([int]$x, [int]$y) { $a = Abs $x $y; [void][P2PInput]::Mouse(($MOVE -bor $ABS -bor $VDESK), $a[0], $a[1], 0) }
function Reset {
  foreach ($k in @($heldKeys.Keys)) { [void][P2PInput]::Key([uint16]$heldKeys[$k][0], [bool]$heldKeys[$k][1], $true) }
  foreach ($b in @($held.Keys)) { [void][P2PInput]::Mouse($UP[[int]$b], 0, 0, 0) }
  $heldKeys.Clear(); $held.Clear()
}
[Console]::Error.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim().Split(' ')
  try {
    switch ($p[0]) {
      'm' { Move ([int][double]$p[1]) ([int][double]$p[2]) }
      'd' { $b = [int]$p[1]; if ($DOWN.ContainsKey($b)) { Move ([int][double]$p[2]) ([int][double]$p[3]); [void][P2PInput]::Mouse($DOWN[$b], 0, 0, 0); $held[$b] = $true } }
      'u' { $b = [int]$p[1]; if ($UP.ContainsKey($b)) { Move ([int][double]$p[2]) ([int][double]$p[3]); [void][P2PInput]::Mouse($UP[$b], 0, 0, 0); $held.Remove($b) } }
      'w' { Move ([int][double]$p[3]) ([int][double]$p[4]); $dx = [int][double]$p[1]; $dy = [int][double]$p[2]
            if ($dy -ne 0) { [void][P2PInput]::Mouse($WHEEL, 0, 0, [int](-$dy * 3)) }      # 40 px = one notch (120)
            if ($dx -ne 0) { [void][P2PInput]::Mouse($HWHEEL, 0, 0, [int]($dx * 3)) } }
      'k' { $scan = [uint16]$p[1]; $ext = ($p[2] -eq '1'); $down = ($p[3] -eq '1')
            [void][P2PInput]::Key($scan, $ext, (-not $down))
            $id = "$scan/$ext"; if ($down) { $heldKeys[$id] = @($scan, $ext) } else { $heldKeys.Remove($id) } }
      'r' { Reset }
    }
  } catch { [Console]::Error.WriteLine("err $($_.Exception.Message)") }
}
Reset
