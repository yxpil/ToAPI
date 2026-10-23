param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [ValidateSet('state', 'restore')][string]$Action = 'state'
)

# Real window state via Win32 GetWindowPlacement (showCmd):
# 1 = normal, 2 = minimized, 3 = maximized.
# Electron's CDP Browser domain has no getWindowForTarget, so ask Windows directly.
$source = @'
using System;
using System.Runtime.InteropServices;

public class ToApiWin {
  [DllImport("user32.dll")]
  public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  public struct POINT { public int x; public int y; }
  public struct RECT { public int left; public int top; public int right; public int bottom; }
  public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  public static int State(IntPtr h) {
    WINDOWPLACEMENT p = new WINDOWPLACEMENT();
    p.length = Marshal.SizeOf(p);
    GetWindowPlacement(h, ref p);
    return p.showCmd;
  }
}
'@

Add-Type -TypeDefinition $source

$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$proc.Refresh()
$handle = $proc.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) {
  Write-Output 'no-window'
  exit 2
}

if ($Action -eq 'restore') {
  [ToApiWin]::ShowWindow($handle, 9) | Out-Null
  Start-Sleep -Milliseconds 400
}

switch ([ToApiWin]::State($handle)) {
  1 { Write-Output 'normal' }
  2 { Write-Output 'minimized' }
  3 { Write-Output 'maximized' }
  default { Write-Output 'unknown' }
}
